import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { progress } from './progress';
import { walk } from './walk';

export interface DirNode {
  name: string;
  path: string;
  /** Bytes of all files below this folder (hard links counted once per index). */
  bytes: number;
  files: number;
  /** Bytes of files directly in this folder (or anywhere below it, past maxDepth). */
  ownBytes: number;
  ownFiles: number;
  /** Newest modified time of any file below. */
  newest: number;
  children: Map<string, DirNode>;
  /** readdir failed — size is unknown. */
  unreadable?: boolean;
}

export interface FileEntry {
  id: number;
  path: string;
  bytes: number;
  mtime: number;
}

export interface DriveIndex {
  root: string;
  tree: DirNode;
  /** Same as tree.bytes. */
  total: number;
  files: number;
  dirs: number;
  /** Estimated space on disk: sizes rounded up to whole clusters (tiny files live inside the MFT). */
  allocated: number;
  clusterSize: number;
  /** Bytes skipped because another hard link to the same file was already counted. */
  hardLinkSaved: number;
  topFiles: FileEntry[];
  byExt: Map<string, { bytes: number; files: number }>;
  /** Folders that could not be read (first 500). */
  unreadable: string[];
  unreadableCount: number;
  /** Files that could not be stat'ed (in use system files like pagefile.sys, first 200). */
  unstatable: string[];
  errors: number;
  maxDepth: number;
  ms: number;
}

export interface IndexOptions {
  /** Folder levels kept in the tree; deeper folders are folded into their ancestor at this depth. */
  maxDepth?: number;
  /** Number of largest files kept. */
  topFiles?: number;
  /** Return false to skip a sub-tree. */
  skipDir?: (dir: string, name: string) => boolean;
  /** Expected bytes (used space), so progress can show a percentage. */
  expectedBytes?: number;
}

/** Files up to about this size are stored inside their MFT record and take no clusters. */
const MFT_RESIDENT = 700;

const newNode = (name: string, p: string): DirNode => ({ name, path: p, bytes: 0, files: 0, ownBytes: 0, ownFiles: 0, newest: 0, children: new Map() });

/** One full walk of `root` that feeds the treemap, largest folders/files, per-extension totals and the "where did it go" report. */
export async function buildIndex(root: string, opts: IndexOptions = {}): Promise<DriveIndex> {
  const maxDepth = opts.maxDepth ?? 4;
  const topN = opts.topFiles ?? 200;
  const rootPath = path.resolve(root);
  const tree = newNode(rootPath, rootPath);
  const byExt = new Map<string, { bytes: number; files: number }>();
  const seen = new Set<string>();
  const unreadable: string[] = [];
  const unstatable: string[] = [];
  let unreadableCount = 0;
  let hardLinkSaved = 0;
  let top: FileEntry[] = [];
  let minTop = 0;
  let nextId = 1;
  let allocated = 0;
  let clusterSize = 4096;
  try {
    clusterSize = (await fsp.statfs(rootPath)).bsize || 4096;
  } catch {
    /* keep default */
  }

  /** Node for a folder path (relative segments), creating it down to maxDepth. */
  const nodeFor = (segs: string[]): DirNode => {
    let n = tree;
    const limit = Math.min(segs.length, maxDepth);
    for (let i = 0; i < limit; i++) {
      const name = segs[i]!;
      const key = name.toLowerCase();
      let child = n.children.get(key);
      if (!child) {
        child = newNode(name, path.join(n.path, name));
        n.children.set(key, child);
      }
      n = child;
    }
    return n;
  };
  const segsOf = (p: string) => {
    const rel = path.relative(rootPath, p);
    return rel ? rel.split(path.sep) : [];
  };

  const t0 = Date.now();
  progress.start(`indexing ${rootPath}`, opts.expectedBytes);
  const w = await walk(rootPath, {
    concurrency: 32,
    onDir: (dir, name) => {
      if (opts.skipDir && !opts.skipDir(dir, name)) return false;
      nodeFor(segsOf(dir));
      return true;
    },
    onError: (p, _code, isDir) => {
      if (isDir) {
        unreadableCount++;
        if (unreadable.length < 500) unreadable.push(p);
        const segs = segsOf(p);
        if (segs.length <= maxDepth) nodeFor(segs).unreadable = true;
      } else if (unstatable.length < 200) unstatable.push(p);
    },
    onFile: async (f, st) => {
      if (st.nlink > 1) {
        try {
          // 64-bit NTFS file IDs need bigint to be unique.
          const b = await fsp.lstat(f, { bigint: true });
          const key = `${b.dev}:${b.ino}`;
          if (seen.has(key)) {
            hardLinkSaved += st.size;
            return;
          }
          seen.add(key);
        } catch {
          /* count it */
        }
      }
      const size = st.size;
      progress.addBytes(size);
      if (size > MFT_RESIDENT) allocated += Math.ceil(size / clusterSize) * clusterSize;
      const segs = segsOf(f);
      segs.pop();
      // Add to every ancestor up to maxDepth.
      let n = tree;
      n.bytes += size;
      n.files++;
      if (st.mtimeMs > n.newest) n.newest = st.mtimeMs;
      const limit = Math.min(segs.length, maxDepth);
      for (let i = 0; i < limit; i++) {
        const name = segs[i]!;
        const key = name.toLowerCase();
        let child = n.children.get(key);
        if (!child) {
          child = newNode(name, path.join(n.path, name));
          n.children.set(key, child);
        }
        n = child;
        n.bytes += size;
        n.files++;
        if (st.mtimeMs > n.newest) n.newest = st.mtimeMs;
      }
      n.ownBytes += size;
      n.ownFiles++;

      const ext = path.extname(f).toLowerCase() || '(none)';
      const e = byExt.get(ext) ?? { bytes: 0, files: 0 };
      e.bytes += size;
      e.files++;
      byExt.set(ext, e);

      if (size > minTop || top.length < topN) {
        top.push({ id: nextId++, path: f, bytes: size, mtime: st.mtimeMs });
        if (top.length > topN * 4) {
          top.sort((a, b) => b.bytes - a.bytes).length = topN;
          minTop = top[top.length - 1]?.bytes ?? 0;
        }
      }
    },
  });
  progress.done();
  top = top.sort((a, b) => b.bytes - a.bytes).slice(0, topN);

  return {
    root: rootPath,
    tree,
    total: tree.bytes,
    allocated,
    clusterSize,
    files: w.files,
    dirs: w.dirs,
    hardLinkSaved,
    topFiles: top,
    byExt,
    unreadable,
    unreadableCount,
    unstatable,
    errors: w.errors,
    maxDepth,
    ms: Date.now() - t0,
  };
}

/** Node at an absolute path inside the index, or undefined when it is deeper than maxDepth / unknown. */
export function findNode(idx: DriveIndex, p: string): DirNode | undefined {
  const rel = path.relative(idx.root, path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  let n: DirNode | undefined = idx.tree;
  for (const seg of rel ? rel.split(path.sep) : []) {
    n = n.children.get(seg.toLowerCase());
    if (!n) return undefined;
  }
  return n;
}

/** All nodes exactly `depth` levels below the root (depth 1 = top-level folders). */
export function nodesAtDepth(idx: DriveIndex, depth: number): DirNode[] {
  let level = [idx.tree];
  for (let d = 0; d < depth; d++) level = level.flatMap((n) => [...n.children.values()]);
  return level;
}

/** JSON-friendly copy of a sub-tree, children sorted by size and trimmed. */
export function nodeJson(n: DirNode, depth = 1, maxChildren = 60): object {
  const kids = [...n.children.values()].sort((a, b) => b.bytes - a.bytes);
  return {
    name: n.name,
    path: n.path,
    bytes: n.bytes,
    files: n.files,
    ownBytes: n.ownBytes,
    newest: n.newest,
    unreadable: !!n.unreadable,
    hasChildren: kids.length > 0,
    children: depth > 0 ? kids.slice(0, maxChildren).map((k) => nodeJson(k, depth - 1, maxChildren)) : undefined,
    moreChildren: Math.max(0, kids.length - maxChildren),
  };
}
