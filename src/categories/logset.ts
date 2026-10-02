import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtBytes } from '../lib/format';
import { deleteFile, isSafeTarget, rejectLogDir, samePath, trimActiveLog } from '../lib/fsops';
import { isAborted, progress } from '../lib/progress';
import { newestTime } from './fileset';
import { emptyClean, emptyScan, type Category, type Ctx, type Item, type ScanResult } from './types';

export interface LogFiles {
  /** Logs a running process writes to: trimmed when too big, never deleted. */
  active: string[];
  /** Folders whose other log-like files are rotated copies: deleted when older than --log-age. */
  dirs: string[];
  notes: string[];
}

/** File names treated as (rotated) logs inside a log folder. */
export const LOG_NAME = /(\.log|\.txt|\.out|\.err|\.gz|\.zip|\.\d+)$/i;

export interface LogSetSpec extends Omit<Category, 'scan' | 'clean'> {
  find: (ctx: Ctx) => Promise<LogFiles>;
}

/** A category for application logs: trim the active ones, delete old rotated ones. */
export function logSet(spec: LogSetSpec): Category {
  const { find, ...meta } = spec;
  return {
    ...meta,
    async scan(ctx): Promise<ScanResult> {
      const res = emptyScan();
      const found = await find(ctx);
      res.notes.push(...found.notes);
      const max = ctx.options.logMaxMb * 1024 ** 2;
      const keep = ctx.options.logKeepMb * 1024 ** 2;
      const cutoff = Date.now() - ctx.options.logAgeDays * 86_400_000;
      const active = new Set(found.active.map((f) => path.resolve(f).toLowerCase()));
      const add = (item: Item) => {
        res.items.push(item);
        res.bytes += item.bytes;
        res.files++;
      };

      for (const f of found.active) {
        const reason = rejectLogDir(path.dirname(f));
        if (reason) {
          res.notes.push(`ignored ${f}: ${reason}`);
          continue;
        }
        const st = await fsp.stat(f).catch(() => undefined);
        if (!st?.isFile() || st.size <= max) continue;
        add({ path: f, root: path.dirname(f), bytes: st.size - keep, action: 'trim', detail: `active log ${fmtBytes(st.size)} → keep last ${fmtBytes(keep)}` });
      }
      for (const dir of found.dirs) {
        if (isAborted()) break;
        if (rejectLogDir(dir)) continue;
        progress.start(`${meta.id}: ${dir}`);
        const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of ents) {
          if (!e.isFile() || !LOG_NAME.test(e.name)) continue;
          const f = path.join(dir, e.name);
          if (active.has(f.toLowerCase())) continue;
          const st = await fsp.stat(f).catch(() => undefined);
          if (!st || newestTime(st) > cutoff) continue;
          add({ path: f, root: dir, bytes: st.size, action: 'delete', detail: 'rotated / old log' });
        }
        progress.done();
      }
      res.items.sort((a, b) => b.bytes - a.bytes);
      if (res.items.some((i) => i.action === 'trim'))
        res.notes.push(`active logs over ${ctx.options.logMaxMb} MB are trimmed in place (--log-max-mb / --log-keep-mb)`);
      res.notes.push(`rotated logs older than ${ctx.options.logAgeDays} days are deleted`);
      return res;
    },

    async clean(ctx, scan) {
      const res = emptyClean();
      const keep = ctx.options.logKeepMb * 1024 ** 2;
      for (const item of scan.items) {
        if (isAborted()) break;
        const root = item.root ?? path.dirname(item.path);
        if (!isSafeTarget(item.path, root) || rejectLogDir(root) || !samePath(path.dirname(item.path), root)) {
          ctx.log.warn(`refused (outside root or protected): ${item.path}`);
          continue;
        }
        if (ctx.dryRun) {
          res.deleted++;
          res.freedBytes += item.bytes;
          ctx.log.debug(`[dry-run] ${item.action === 'trim' ? 'trim' : 'delete'} ${item.path} (${fmtBytes(item.bytes)})`);
          continue;
        }
        if (item.action === 'trim') {
          const r = await trimActiveLog(item.path, keep);
          if (r) {
            res.deleted++;
            res.freedBytes += r.freed;
            ctx.log.debug(`trimmed ${item.path} (−${fmtBytes(r.freed)}, ${fmtBytes(r.size)} kept)`);
          } else {
            res.failed++;
            ctx.log.debug(`locked / denied: ${item.path}`);
          }
        } else if (await deleteFile(item.path)) {
          res.deleted++;
          res.freedBytes += item.bytes;
          ctx.log.debug(`deleted ${item.path} (${fmtBytes(item.bytes)})`);
        } else {
          res.failed++;
          ctx.log.debug(`in use / denied: ${item.path}`);
        }
      }
      if (res.failed) res.notes.push(`${res.failed} files skipped (locked or access denied)`);
      return res;
    },
  };
}
