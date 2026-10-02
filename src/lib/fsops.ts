import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { winPaths } from './sys';

const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
export const samePath = (a: string, b: string) => norm(a) === norm(b);
export const isInside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c !== p && c.startsWith(p + path.sep);
};
const isDriveRoot = (p: string) => /^[a-z]:$/i.test(norm(p)) || norm(p) === '' || norm(p) === '/';

/** Folders nothing in this tool may ever delete from, unless a built-in category root lives inside them. */
function hardDeny(): string[] {
  const w = winPaths();
  return [
    `${w.systemRoot}\\System32`,
    `${w.systemRoot}\\SysWOW64`,
    `${w.systemRoot}\\WinSxS`,
    `${w.systemRoot}\\Installer`,
    `${w.systemRoot}\\Boot`,
    `${w.systemRoot}\\Fonts`,
    w.programFiles,
    w.programFilesX86,
  ];
}

/** Is `root` acceptable as a user-configured clean-up root? Returns a reason when not. */
export function rejectCustomRoot(root: string): string | undefined {
  if (!path.isAbsolute(root)) return 'path must be absolute';
  if (isDriveRoot(root)) return 'refusing to clean a whole drive';
  const w = winPaths();
  if (samePath(root, w.systemRoot) || samePath(root, w.usersDir)) return 'refusing to clean a top-level system folder';
  for (const d of hardDeny()) if (samePath(root, d) || isInside(root, d)) return `inside protected folder ${d}`;
  return undefined;
}

/**
 * Is `dir` acceptable as a folder of application logs (pm2, nginx)? Narrower than rejectCustomRoot:
 * an app's own folder under Program Files is fine (only log-named files in it are touched), Windows is not.
 */
export function rejectLogDir(dir: string): string | undefined {
  if (!path.isAbsolute(dir)) return 'path must be absolute';
  if (isDriveRoot(dir)) return 'refusing a drive root';
  const w = winPaths();
  for (const d of [w.usersDir, w.programFiles, w.programFilesX86, w.programData]) if (samePath(dir, d)) return 'refusing a top-level system folder';
  if (samePath(dir, w.systemRoot) || isInside(dir, w.systemRoot)) return 'inside the Windows folder';
  return undefined;
}

/** Final safety check before any delete: target must be strictly inside its declared root. */
export function isSafeTarget(target: string, root: string, rootIsFile = false): boolean {
  if (samePath(target, root)) return rootIsFile; // single-file roots like MEMORY.DMP
  if (!isInside(target, root)) return false;
  for (const d of hardDeny()) {
    if ((samePath(target, d) || isInside(target, d)) && !(samePath(root, d) || isInside(root, d))) return false;
  }
  return true;
}

export async function deleteFile(p: string): Promise<boolean> {
  try {
    await fsp.unlink(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'EPERM' || code === 'EACCES') {
      // Read-only attribute → clear it and retry. Files open by a process still fail (EBUSY).
      try {
        await fsp.chmod(p, 0o666);
        await fsp.unlink(p);
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }
}

export async function deleteTree(p: string): Promise<boolean> {
  try {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

/** Remove empty sub-directories (never `root` itself) created before `cutoffMs`. */
export async function removeEmptyDirs(root: string, cutoffMs: number): Promise<number> {
  let removed = 0;
  async function rec(dir: string, isRoot: boolean): Promise<boolean> {
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!(await rec(path.join(dir, e.name), false))) empty = false;
      } else empty = false;
    }
    if (!empty || isRoot) return false;
    try {
      const st = await fsp.stat(dir);
      if ((process.platform === 'win32' ? st.birthtimeMs : st.mtimeMs) > cutoffMs) return false;
      await fsp.rmdir(dir);
      removed++;
      return true;
    } catch {
      return false;
    }
  }
  await rec(root, true);
  return removed;
}

/**
 * Shrink a log that a running process keeps open to its last `keepBytes` (starting at a line break).
 * Writers that append (pm2/libuv, nginx) carry on at the new end of the file. Lines written during the
 * few milliseconds of the trim can be lost. Returns undefined when the file is locked or unreadable.
 */
export async function trimActiveLog(file: string, keepBytes: number): Promise<{ freed: number; size: number } | undefined> {
  let fh;
  try {
    fh = await fsp.open(file, 'r+');
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    if (size <= keepBytes) return { freed: 0, size };
    let tail = Buffer.alloc(0);
    if (keepBytes > 0) {
      const buf = Buffer.alloc(keepBytes);
      const { bytesRead } = await fh.read(buf, 0, keepBytes, size - keepBytes);
      tail = buf.subarray(0, bytesRead);
      const nl = tail.indexOf(0x0a);
      if (nl >= 0 && nl < tail.length - 1) tail = tail.subarray(nl + 1);
    }
    await fh.truncate(0);
    if (tail.length) await fh.write(tail, 0, tail.length, 0);
    return { freed: size - tail.length, size: tail.length };
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Move a file, falling back to copy + delete across drives. */
export async function moveFile(src: string, dest: string): Promise<boolean> {
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    }
    return true;
  } catch {
    return false;
  }
}
