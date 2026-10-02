import type { Category, Ctx, ScanResult } from '../categories';
import { c, fmtBytes, fmtNum, table } from '../lib/format';
import { isAborted, progress } from '../lib/progress';
import { driveSpace, fixedDrives, isWindows, type DriveSpace } from '../lib/sys';

export interface Entry {
  cat: Category;
  res: ScanResult;
  ms: number;
}

export async function scanAll(ctx: Ctx, cats: Category[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const cat of cats) {
    if (isAborted()) break;
    const t0 = Date.now();
    let res: ScanResult;
    try {
      res = await cat.scan(ctx);
    } catch (e) {
      progress.done();
      res = { bytes: 0, files: 0, items: [], errors: 1, notes: [`scan failed: ${(e as Error).message}`] };
    }
    if (res.errors && !ctx.admin && cat.needsAdmin) res.notes.push('some locations were not readable — run elevated for full results');
    out.push({ cat, res, ms: Date.now() - t0 });
    ctx.log.debug(`scanned ${cat.id}: ${fmtBytes(res.bytes)} in ${res.files} files (${Date.now() - t0} ms)`);
  }
  return out;
}

export async function allDriveSpace(): Promise<DriveSpace[]> {
  const drives = isWindows ? await fixedDrives() : ['/'];
  return (await Promise.all(drives.map(driveSpace))).filter((d): d is DriveSpace => !!d);
}

export function printDrives(ctx: Ctx, drives: DriveSpace[]) {
  const rows = [[c.bold('Drive'), c.bold('Size'), c.bold('Free'), c.bold('Used')]];
  for (const d of drives) {
    const pct = d.total ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
    const used = `${pct}%`;
    rows.push([d.drive, fmtBytes(d.total), fmtBytes(d.free), pct >= 90 ? c.red(used) : pct >= 80 ? c.yellow(used) : used]);
  }
  ctx.log.info(table(rows, ['l', 'r', 'r', 'r']));
  ctx.log.info();
}

const riskLabel = (e: Entry) =>
  e.cat.reportOnly ? c.dim('info') : e.cat.risk === 'safe' ? c.green('safe') : e.cat.risk === 'moderate' ? c.yellow('moderate') : c.red('caution');

export function printEntries(ctx: Ctx, entries: Entry[], opts: { details?: boolean; maxItems?: number } = {}) {
  const rows = [[c.bold('ID'), c.bold('Category'), c.bold('Size'), c.bold('Files'), c.bold('Risk')]];
  for (const e of entries) {
    const size = e.res.bytes ? fmtBytes(e.res.bytes) : c.dim('—');
    rows.push([c.cyan(e.cat.id), e.cat.title, size, e.res.files ? fmtNum(e.res.files) : '', riskLabel(e)]);
  }
  ctx.log.info(table(rows, ['l', 'l', 'r', 'r', 'l']));

  const total = entries.filter((e) => !e.cat.reportOnly).reduce((s, e) => s + e.res.bytes, 0);
  ctx.log.info(`\n${c.bold('Reclaimable:')} ${c.green(fmtBytes(total))}  ${c.dim('(info rows not included)')}`);

  if (opts.details === false) return;
  for (const e of entries) {
    if (!e.res.items.length && !e.res.notes.length) continue;
    ctx.log.info(`\n${c.cyan(e.cat.id)} ${c.dim('— ' + e.cat.description)}`);
    const items = e.res.items.slice(0, opts.maxItems ?? 8);
    for (const i of items) {
      ctx.log.info(`  ${fmtBytes(i.bytes).padStart(9)}  ${i.path}${i.detail ? c.dim(`  (${i.detail})`) : ''}`);
    }
    if (e.res.items.length > items.length) ctx.log.info(c.dim(`  … and ${e.res.items.length - items.length} more`));
    for (const n of e.res.notes) ctx.log.info(c.dim(`  · ${n}`));
  }
}

export const toJson = (entries: Entry[], drives: DriveSpace[]) => ({
  host: process.env.COMPUTERNAME,
  time: new Date().toISOString(),
  drives,
  categories: entries.map((e) => ({
    id: e.cat.id,
    group: e.cat.group,
    title: e.cat.title,
    risk: e.cat.risk,
    reportOnly: !!e.cat.reportOnly,
    bytes: e.res.bytes,
    files: e.res.files,
    items: e.res.items,
    notes: e.res.notes,
    durationMs: e.ms,
  })),
});
