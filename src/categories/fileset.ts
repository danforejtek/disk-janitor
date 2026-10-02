import { promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { fmtBytes } from '../lib/format';
import { deleteFile, isSafeTarget, removeEmptyDirs } from '../lib/fsops';
import { isAborted, progress } from '../lib/progress';
import { isWindows, serviceRunning, startService, stopService } from '../lib/sys';

/** Newest of modified/created. Creation time is only meaningful on Windows (copied files keep an old mtime). */
export const newestTime = (st: Stats) => (isWindows ? Math.max(st.mtimeMs, st.birthtimeMs) : st.mtimeMs);
import { measure, walk } from '../lib/walk';
import { emptyClean, type Category, type CleanResult, type Ctx, type ScanResult } from './types';

export interface FileSetSpec extends Omit<Category, 'scan' | 'clean'> {
  roots: (ctx: Ctx) => string[] | Promise<string[]>;
  /** Only files whose newest timestamp (modified or created) is older than this are touched. */
  minAgeDays: (ctx: Ctx) => number;
  /** Extra filter on the file name. */
  match?: (name: string) => boolean;
  /** Windows services to stop while cleaning (restarted afterwards if they were running). */
  services?: string[];
  pruneEmptyDirs?: boolean;
}

export async function existingRoots(roots: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const key = path.resolve(r).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await fsp.stat(r);
      out.push(r);
    } catch {
      /* missing — skip */
    }
  }
  return out;
}

/** A category that is "files under these folders, optionally older than N days". */
export function fileSet(spec: FileSetSpec): Category {
  const { roots, minAgeDays, match, services, pruneEmptyDirs, ...meta } = spec;
  const cutoff = (ctx: Ctx) => Date.now() - minAgeDays(ctx) * 86_400_000;
  const candidate = (ctx: Ctx) => {
    const c = cutoff(ctx);
    return (f: string, st: Stats) =>
      newestTime(st) <= c && (!match || match(path.basename(f)));
  };

  return {
    ...meta,

    async scan(ctx): Promise<ScanResult> {
      const res: ScanResult = { bytes: 0, files: 0, items: [], notes: [], errors: 0 };
      for (const root of await existingRoots(await roots(ctx))) {
        progress.start(`${meta.id}: ${root}`);
        const m = await measure(root, { filter: candidate(ctx) });
        progress.done();
        res.errors += m.walk.errors;
        if (m.files === 0) continue;
        res.items.push({ path: root, bytes: m.bytes, files: m.files });
        res.bytes += m.bytes;
        res.files += m.files;
      }
      res.items.sort((a, b) => b.bytes - a.bytes);
      const age = minAgeDays(ctx);
      if (age > 0) res.notes.push(`only files older than ${age} days`);
      return res;
    },

    async clean(ctx, scan): Promise<CleanResult> {
      const res = emptyClean();
      const restart: string[] = [];
      if (!ctx.dryRun && services?.length && isWindows) {
        for (const svc of services) {
          if (!(await serviceRunning(svc))) continue;
          const r = await stopService(svc);
          ctx.log.debug(`stop service ${svc}: exit ${r.code}`);
          restart.push(svc);
        }
      }
      try {
        for (const item of scan.items) {
          if (isAborted()) break;
          const root = item.path;
          const rootIsFile = (await fsp.stat(root).catch(() => undefined))?.isFile() ?? false;
          const isCandidate = candidate(ctx);
          progress.start(`${meta.id}: cleaning ${root}`);
          await walk(root, {
            concurrency: 8,
            onFile: async (f, st) => {
              if (!isCandidate(f, st)) return;
              if (!isSafeTarget(f, root, rootIsFile)) {
                ctx.log.warn(`refused (outside root or protected): ${f}`);
                return;
              }
              if (ctx.dryRun) {
                res.deleted++;
                res.freedBytes += st.size;
                ctx.log.debug(`[dry-run] ${f} (${fmtBytes(st.size)})`);
              } else if (await deleteFile(f)) {
                res.deleted++;
                res.freedBytes += st.size;
                ctx.log.debug(`deleted ${f} (${fmtBytes(st.size)})`);
              } else {
                res.failed++;
                ctx.log.debug(`in use / denied: ${f}`);
              }
            },
          });
          progress.done();
          if (!ctx.dryRun && !rootIsFile && pruneEmptyDirs !== false) {
            const n = await removeEmptyDirs(root, cutoff(ctx));
            if (n) ctx.log.debug(`removed ${n} empty folders under ${root}`);
          }
        }
      } finally {
        for (const svc of restart.reverse()) {
          const r = await startService(svc);
          ctx.log.debug(`start service ${svc}: exit ${r.code}`);
        }
      }
      if (res.failed) res.notes.push(`${res.failed} files skipped (in use or access denied)`);
      return res;
    },
  };
}
