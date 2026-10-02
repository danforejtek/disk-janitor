import path from 'node:path';
import type { Ctx } from '../categories';
import { buildIndex, type DirNode } from '../lib/driveindex';
import { c, fmtBytes, fmtDate, fmtNum, table } from '../lib/format';

/** WizTree-style report: biggest folders (at a given depth) and biggest files under a path. */
export async function cmdDu(ctx: Ctx, target: string, depth: number, top: number): Promise<number> {
  const root = path.resolve(target);
  const idx = await buildIndex(root, { maxDepth: depth, topFiles: top });
  const total = idx.total;

  // Bucket = folder at `depth`, or the files directly in a shallower folder.
  const buckets: Array<{ path: string; bytes: number; files: number }> = [];
  const rec = (n: DirNode, d: number) => {
    if (d === depth) {
      if (n.bytes) buckets.push({ path: n.path, bytes: n.bytes, files: n.files });
      return;
    }
    if (n.ownBytes) buckets.push({ path: d === 0 ? `${root}${path.sep}<files>` : n.path, bytes: n.ownBytes, files: n.ownFiles });
    for (const ch of n.children.values()) rec(ch, d + 1);
  };
  rec(idx.tree, 0);

  ctx.log.info(`${c.bold(root)}  ${fmtBytes(total)} in ${fmtNum(idx.files)} files, ${fmtNum(idx.dirs)} folders  ${c.dim(`(${(idx.ms / 1000).toFixed(1)} s)`)}`);
  if (idx.unreadableCount)
    ctx.log.info(c.yellow(`${fmtNum(idx.unreadableCount)} folders not readable${ctx.admin ? '' : ' — run elevated'}, e.g. ${idx.unreadable[0]}`));
  if (idx.hardLinkSaved) ctx.log.info(c.dim(`${fmtBytes(idx.hardLinkSaved)} of hard links counted once (Explorer counts them twice).`));
  ctx.log.info(c.dim('Symlinks/junctions are not followed. Shadow copies, pagefile & hiberfil: see `explain`.\n'));

  const sorted = buckets.sort((a, b) => b.bytes - a.bytes).slice(0, top);
  const bar = (n: number) => '█'.repeat(Math.max(0, Math.round((n / (total || 1)) * 20)));
  ctx.log.info(c.bold(`Largest folders (depth ${depth})`));
  ctx.log.info(
    table(
      sorted.map((d) => [fmtBytes(d.bytes), `${Math.round((d.bytes / (total || 1)) * 100)}%`, c.cyan(bar(d.bytes).padEnd(20)), fmtNum(d.files), d.path]),
      ['r', 'r', 'l', 'r', 'l'],
    ),
  );
  ctx.log.info(`\n${c.bold('Largest files')}`);
  ctx.log.info(table(idx.topFiles.slice(0, top).map((f) => [fmtBytes(f.bytes), c.dim(fmtDate(f.mtime)), f.path]), ['r', 'l', 'l']));
  return 0;
}

/** What a big file of this type usually is. */
const TYPE_HINTS: Record<string, string> = {
  '.vhdx': 'virtual disk (Hyper-V, WSL, Docker Desktop) — compact with Optimize-VHD',
  '.vhd': 'virtual disk',
  '.iso': 'installation media',
  '.bak': 'backup (SQL Server?)',
  '.trn': 'SQL transaction log backup',
  '.ldf': 'SQL transaction log — shrink only after a log backup',
  '.mdf': 'SQL database',
  '.dmp': 'crash/memory dump',
  '.log': 'log file — rotate it',
  '.etl': 'trace log',
  '.evtx': 'event log',
  '.edb': 'ESE database (Windows Search index?)',
  '.zip': 'archive',
  '.7z': 'archive',
  '.gz': 'archive / rotated log',
  '.msi': 'installer',
  '.msp': 'installer patch',
  '.cab': 'cabinet (update / CBS log archive)',
  '.wim': 'Windows image',
  '.pst': 'Outlook data file',
  '.tmp': 'temp file',
};

/** Parse "500MB", "2 GB", "1.5g", "1048576" → bytes. */
export function parseSizeArg(s: string): number {
  const m = /^\s*([\d.]+)\s*([kmgt]?)b?\s*$/i.exec(s);
  if (!m?.[1]) throw new Error(`invalid size "${s}" (e.g. 500MB, 2GB)`);
  const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.round(Number.parseFloat(m[1]) * (mult[(m[2] ?? '').toLowerCase()] ?? 1));
}

/** Every file over `minBytes` on the given roots, plus space per file type. */
export async function cmdBig(ctx: Ctx, roots: string[], minBytes: number, top: number): Promise<number> {
  const all: Array<{ path: string; bytes: number; mtime: number }> = [];
  const byExt = new Map<string, { bytes: number; files: number }>();
  for (const r of roots) {
    const idx = await buildIndex(r, { maxDepth: 1, topFiles: Math.max(top, 2000) });
    all.push(...idx.topFiles.filter((f) => f.bytes >= minBytes));
    for (const [ext, v] of idx.byExt) {
      const e = byExt.get(ext) ?? { bytes: 0, files: 0 };
      e.bytes += v.bytes;
      e.files += v.files;
      byExt.set(ext, e);
    }
  }
  all.sort((a, b) => b.bytes - a.bytes);
  const total = all.reduce((s, f) => s + f.bytes, 0);
  ctx.log.info(c.bold(`${fmtNum(all.length)} files over ${fmtBytes(minBytes)} — ${fmtBytes(total)}`) + c.dim(`  (${roots.join(', ')})`));
  const now = Date.now();
  ctx.log.info(
    table(
      all.slice(0, top).map((f) => {
        const ext = path.extname(f.path).toLowerCase();
        const age = Math.floor((now - f.mtime) / 86_400_000);
        return [fmtBytes(f.bytes), c.dim(`${fmtDate(f.mtime)} (${age}d)`), f.path, c.dim(TYPE_HINTS[ext] ?? '')];
      }),
      ['r', 'l', 'l', 'l'],
    ),
  );
  if (all.length > top) ctx.log.info(c.dim(`… and ${all.length - top} more (--top)`));

  ctx.log.info(`\n${c.bold('Space by file type')}`);
  const types = [...byExt.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15);
  ctx.log.info(table(types.map(([ext, v]) => [fmtBytes(v.bytes), ext, fmtNum(v.files), c.dim(TYPE_HINTS[ext] ?? '')]), ['r', 'l', 'r', 'l']));
  return 0;
}
