import { promises as fsp, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import { isAborted, progress } from './progress';

export interface WalkOptions {
  /** Called for every sub-directory; return false to skip descending into it. */
  onDir?: (dir: string, name: string, depth: number) => boolean | Promise<boolean>;
  /** Called for every regular file. Files are lstat'ed only when this is set. */
  onFile?: (file: string, st: Stats, depth: number) => void | Promise<void>;
  concurrency?: number;
  /** Called for every unreadable entry (vanished entries are ignored). */
  onError?: (path: string, code: string | undefined, isDir: boolean) => void;
}

export interface WalkStats {
  files: number;
  dirs: number;
  errors: number;
  errorSamples: string[];
}

const BATCH = 64;

/**
 * Parallel directory walker.
 * - Never follows symlinks or junctions (prevents double counting and escaping the root).
 * - Non-link reparse points (dedup / cloud placeholder files) are still treated as files.
 * - Access-denied and vanished entries are counted, not thrown.
 */
export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkStats> {
  const stats: WalkStats = { files: 0, dirs: 0, errors: 0, errorSamples: [] };
  const fail = (p: string, e: unknown, isDir = false) => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    stats.errors++;
    if (stats.errorSamples.length < 5) stats.errorSamples.push(`${p} (${code ?? String(e)})`);
    opts.onError?.(p, code, isDir);
  };

  let rootStat: Stats;
  try {
    rootStat = await fsp.stat(root);
  } catch (e) {
    fail(root, e, true);
    return stats;
  }
  if (rootStat.isFile()) {
    stats.files++;
    await opts.onFile?.(root, rootStat, 0);
    return stats;
  }
  if (!rootStat.isDirectory()) return stats;

  const stack: Array<[string, number]> = [[root, 0]];
  const conc = opts.concurrency ?? 16;
  let active = 0;

  async function processDir(dir: string, depth: number) {
    if (isAborted()) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      fail(dir, e, true);
      return;
    }
    stats.dirs++;
    const files: string[] = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!opts.onDir || (await opts.onDir(full, ent.name, depth + 1))) stack.push([full, depth + 1]);
      } else if (ent.isFile()) {
        files.push(full);
      } else if (ent.isSymbolicLink()) {
        // Windows reports every reparse point as a link; keep the ones that are really files.
        if (opts.onFile) {
          try {
            const st = await fsp.lstat(full);
            if (st.isFile()) files.push(full);
          } catch (e) {
            fail(full, e);
          }
        }
      }
    }
    if (!opts.onFile) {
      stats.files += files.length;
      progress.tick(files.length);
      return;
    }
    for (let i = 0; i < files.length && !isAborted(); i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async (full) => {
          try {
            const st = await fsp.lstat(full);
            stats.files++;
            progress.tick();
            await opts.onFile!(full, st, depth + 1);
          } catch (e) {
            fail(full, e);
          }
        }),
      );
    }
  }

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < conc && stack.length) {
        const [d, depth] = stack.pop()!;
        active++;
        processDir(d, depth)
          .catch((e) => fail(d, e))
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && stack.length === 0) resolve();
    };
    pump();
  });
  return stats;
}

export interface Measure {
  /** Total bytes of matching files (hard-linked files counted once). */
  bytes: number;
  /** Portion of `bytes` in files with more than one hard link (deleting one link frees nothing). */
  linkedBytes: number;
  files: number;
  walk: WalkStats;
}

export async function measure(
  root: string,
  opts: { filter?: (file: string, st: Stats) => boolean; onDir?: WalkOptions['onDir'] } = {},
): Promise<Measure> {
  const seen = new Set<string>();
  let bytes = 0;
  let linked = 0;
  let files = 0;
  const w = await walk(root, {
    onDir: opts.onDir,
    onFile: async (f, st) => {
      if (opts.filter && !opts.filter(f, st)) return;
      if (st.nlink > 1) {
        try {
          // 64-bit NTFS file IDs need bigint to be unique.
          const b = await fsp.lstat(f, { bigint: true });
          const key = `${b.dev}:${b.ino}`;
          if (seen.has(key)) return;
          seen.add(key);
        } catch {
          /* count it anyway */
        }
        linked += st.size;
      }
      files++;
      bytes += st.size;
    },
  });
  return { bytes, linkedBytes: linked, files, walk: w };
}
