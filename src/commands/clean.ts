import { createInterface } from 'node:readline/promises';
import type { Category, Ctx } from '../categories';
import { c, fmtBytes, fmtNum, table } from '../lib/format';
import { isAborted } from '../lib/progress';
import { allDriveSpace, printDrives, printEntries, scanAll, type Entry } from './report';

export interface CleanFlags {
  explicit: boolean; // --only / --group given
  /** IDs named with --only. */
  named: string[];
  yes: boolean;
  safe: boolean;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

export async function cmdClean(ctx: Ctx, cats: Category[], flags: CleanFlags): Promise<number> {
  const cleanable = cats.filter((cat) => cat.clean && !cat.reportOnly);
  if (!cleanable.length) {
    ctx.log.warn('Nothing cleanable selected.');
    return 1;
  }

  const before = await allDriveSpace();
  ctx.log.info(c.bold(`Scanning ${cleanable.length} categories${ctx.dryRun ? ' (dry run)' : ''}…\n`));
  const entries = await scanAll(ctx, cleanable);
  printEntries(ctx, entries);
  ctx.log.info();
  if (isAborted()) return 130;

  const hasWork = (e: Entry) => e.res.bytes > 0 || e.res.items.length > 0;
  let chosen: Entry[];
  // explicitOnly categories (msi-orphans) are cleaned only when named, never through "safe" / "all".
  const bulk = (e: Entry) => hasWork(e) && !e.cat.explicitOnly;
  if (flags.explicit) chosen = entries.filter((e) => hasWork(e) && (!e.cat.explicitOnly || flags.named.includes(e.cat.id)));
  else if (flags.safe) chosen = entries.filter((e) => bulk(e) && e.cat.risk === 'safe');
  else {
    if (!process.stdin.isTTY) {
      ctx.log.warn('Not interactive: pass --only <ids> or --safe, plus --yes.');
      return 1;
    }
    const answer = await ask(
      `Categories to clean — comma-separated IDs, ${c.green('safe')} for all safe ones, ${c.yellow('all')}, or Enter to quit: `,
    );
    if (!answer) return 0;
    const lower = answer.toLowerCase();
    if (lower === 'all') chosen = entries.filter(bulk);
    else if (lower === 'safe') chosen = entries.filter((e) => bulk(e) && e.cat.risk === 'safe');
    else {
      const ids = lower.split(/[\s,]+/).filter(Boolean);
      const unknown = ids.filter((id) => !entries.some((e) => e.cat.id === id));
      if (unknown.length) {
        ctx.log.warn(`Unknown IDs: ${unknown.join(', ')}`);
        return 1;
      }
      chosen = entries.filter((e) => ids.includes(e.cat.id));
    }
  }

  if (!ctx.admin) {
    const skipped = chosen.filter((e) => e.cat.needsAdmin);
    if (skipped.length) ctx.log.warn(`Skipping (needs elevated prompt): ${skipped.map((e) => e.cat.id).join(', ')}`);
    chosen = chosen.filter((e) => !e.cat.needsAdmin);
  }
  if (!chosen.length) {
    ctx.log.info('Nothing to clean.');
    return 0;
  }

  const estimate = chosen.reduce((s, e) => s + e.res.bytes, 0);
  ctx.log.info(`Will ${ctx.dryRun ? c.bold('simulate') + ' cleaning' : c.red('delete')} ~${c.bold(fmtBytes(estimate))} from: ${chosen.map((e) => e.cat.id).join(', ')}`);
  if (!flags.yes && !ctx.dryRun) {
    if (!process.stdin.isTTY) {
      ctx.log.warn('Not interactive and --yes not given — aborting.');
      return 1;
    }
    if (!/^y(es)?$/i.test(await ask('Proceed? [y/N] '))) return 0;
  }
  ctx.log.info();

  const rows = [[c.bold('ID'), c.bold(ctx.dryRun ? 'Would free' : 'Freed'), c.bold('Items'), c.bold('Failed')]];
  let freed = 0;
  for (const e of chosen) {
    if (isAborted()) break;
    ctx.log.info(`${c.cyan('▶')} ${e.cat.id}: ${e.cat.title}`);
    try {
      const r = await e.cat.clean!(ctx, e.res);
      freed += r.freedBytes;
      rows.push([e.cat.id, fmtBytes(r.freedBytes), fmtNum(r.deleted), r.failed ? c.yellow(fmtNum(r.failed)) : '0']);
      for (const n of r.notes) ctx.log.info(c.dim(`    · ${n}`));
    } catch (err) {
      ctx.log.warn(`  ${e.cat.id} failed: ${(err as Error).message}`);
      rows.push([e.cat.id, c.red('error'), '', '']);
    }
  }

  ctx.log.info(`\n${table(rows, ['l', 'r', 'r', 'r'])}\n`);
  ctx.log.info(`${c.bold(ctx.dryRun ? 'Would free:' : 'Freed:')} ${c.green(fmtBytes(freed))}\n`);
  if (!ctx.dryRun) {
    const after = await allDriveSpace();
    printDrives(ctx, after);
    for (const a of after) {
      const b = before.find((x) => x.drive === a.drive);
      if (b && a.free - b.free > 0) ctx.log.info(`${a.drive} gained ${c.green(fmtBytes(a.free - b.free))} free space`);
    }
  }
  if (ctx.log.file) ctx.log.info(c.dim(`\nLog: ${ctx.log.file}`));
  return isAborted() ? 130 : 0;
}
