import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { allCategories, resetCaches, type Category, type Ctx } from '../categories';
import { runExplain, type ExplainResult } from '../commands/explain';
import { allDriveSpace, scanAll, toJson, type Entry } from '../commands/report';
import { selectCategories, VERSION } from '../config';
import { findNode, nodeJson, type DriveIndex } from '../lib/driveindex';
import { fmtBytes } from '../lib/format';
import { deleteFile, isInside, isSafeTarget, samePath } from '../lib/fsops';
import { onProgress, requestAbort, resetAbort, type ProgressEvent } from '../lib/progress';
import { run, winPaths } from '../lib/sys';
import page from './app.html';

const IDLE_MS = 30 * 60_000;
const COOKIE = 'dj_token';

interface Job {
  id: string;
  kind: 'scan' | 'clean' | 'explain';
  label: string;
  started: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const newId = () => randomBytes(6).toString('hex');

/** Keep only the newest `n` entries of a Map (insertion order). */
function cap<K, V>(m: Map<K, V>, n: number) {
  while (m.size > n) m.delete(m.keys().next().value as K);
}

export function createUiServer(ctx: Ctx, opts: { port: number; token?: string; exitWhenClosedMs?: number }) {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const scans = new Map<string, { entries: Entry[]; at: number; dryRunOnly?: boolean }>();
  const explains = new Map<string, { result: ExplainResult; index: DriveIndex }>();
  const clients = new Set<http.ServerResponse>();
  let job: Job | undefined;
  let lastActivity = Date.now();
  // Set once a page has connected; with exitWhenClosedMs the server stops when the last page is gone.
  let lastClient = 0;
  let lastProgress: ProgressEvent | undefined;
  let port = opts.port;

  // ── events (SSE) ───────────────────────────────────────────────────────────
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  let logBuf: Array<{ line: string; level: string }> = [];
  let dropped = 0;
  const flushLog = () => {
    if (!logBuf.length && !dropped) return;
    send('log', { lines: logBuf, dropped });
    logBuf = [];
    dropped = 0;
  };
  const logTimer = setInterval(flushLog, 250);
  ctx.log.sink = (line, level) => {
    if (logBuf.length < 400) logBuf.push({ line, level });
    else dropped++;
  };
  const offProgress = onProgress((e) => {
    lastProgress = e.type === 'done' ? undefined : e;
    send('progress', e);
  });
  const ping = setInterval(() => send('ping', Date.now()), 20_000);

  // ── jobs ───────────────────────────────────────────────────────────────────
  const startJob = (kind: Job['kind'], label: string, fn: () => Promise<unknown>) => {
    if (job) throw new HttpError(409, `busy: ${job.label}`);
    resetAbort();
    resetCaches();
    const j: Job = { id: newId(), kind, label, started: Date.now() };
    job = j;
    send('job', j);
    fn()
      .then((result) => send(`${kind}-done`, { jobId: j.id, ...(result as object) }))
      .catch((e) => {
        ctx.log.warn(`${kind} failed: ${(e as Error).message}`);
        send('job-error', { jobId: j.id, kind, message: (e as Error).message });
      })
      .finally(() => {
        flushLog();
        job = undefined;
        lastProgress = undefined;
        send('job', null);
      });
    return { jobId: j.id };
  };

  const catsInfo = (cats: Category[]) =>
    cats.map((x) => ({
      id: x.id,
      group: x.group,
      title: x.title,
      description: x.description,
      risk: x.risk,
      reportOnly: !!x.reportOnly,
      needsAdmin: !!x.needsAdmin,
      deepOnly: !!x.deepOnly,
      explicitOnly: !!x.explicitOnly,
    }));

  // ── API ────────────────────────────────────────────────────────────────────
  async function api(method: string, route: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
    const get = method === 'GET';
    if (get && route === '/api/info') {
      return {
        version: VERSION,
        host: os.hostname(),
        user: os.userInfo().username,
        admin: ctx.admin,
        systemDrive: winPaths().systemDrive,
        drives: await allDriveSpace(),
        categories: catsInfo(allCategories(ctx)),
        options: ctx.options,
        job,
        progress: job ? lastProgress : undefined,
      };
    }
    if (get && route === '/api/drives') return allDriveSpace();

    if (!get && route === '/api/scan') {
      const cats = selectCategories(allCategories(ctx), {
        only: Array.isArray(body.only) ? (body.only as string[]) : [],
        deep: !!body.deep,
      });
      return startJob('scan', `scanning ${cats.length} categories`, async () => {
        const drives = await allDriveSpace();
        const entries = await scanAll(ctx, cats);
        const scanId = newId();
        scans.set(scanId, { entries, at: Date.now() });
        cap(scans, 5);
        return { scanId, scan: toJson(entries, drives) };
      });
    }

    if (!get && route === '/api/clean') {
      const s = scans.get(String(body.scanId));
      if (!s) throw new HttpError(404, 'scan not found or outdated — scan again');
      const ids = Array.isArray(body.ids) ? (body.ids as string[]).map(String) : [];
      const dryRun = body.dryRun !== false;
      let chosen = s.entries.filter((e) => ids.includes(e.cat.id) && e.cat.clean && !e.cat.reportOnly);
      if (!chosen.length) throw new HttpError(400, 'no cleanable categories selected');
      const skipped = ctx.admin ? [] : chosen.filter((e) => e.cat.needsAdmin).map((e) => e.cat.id);
      chosen = chosen.filter((e) => !skipped.includes(e.cat.id));
      return startJob('clean', `${dryRun ? 'dry run' : 'cleaning'}: ${chosen.map((e) => e.cat.id).join(', ')}`, async () => {
        const before = await allDriveSpace();
        ctx.dryRun = dryRun;
        ctx.log.open(dryRun ? 'ui-dry-run' : 'ui-clean');
        const rows: Array<{ id: string; freed: number; deleted: number; failed: number; notes: string[]; error?: string }> = [];
        try {
          if (skipped.length) ctx.log.warn(`skipped (needs elevated prompt): ${skipped.join(', ')}`);
          for (const e of chosen) {
            ctx.log.info(`▶ ${e.cat.id}: ${e.cat.title}`);
            try {
              const r = await e.cat.clean!(ctx, e.res);
              rows.push({ id: e.cat.id, freed: r.freedBytes, deleted: r.deleted, failed: r.failed, notes: r.notes });
              ctx.log.info(`  ${dryRun ? 'would free' : 'freed'} ${fmtBytes(r.freedBytes)} (${r.deleted} items, ${r.failed} failed)`);
            } catch (err) {
              rows.push({ id: e.cat.id, freed: 0, deleted: 0, failed: 0, notes: [], error: (err as Error).message });
              ctx.log.warn(`  ${e.cat.id} failed: ${(err as Error).message}`);
            }
          }
        } finally {
          ctx.dryRun = false;
          await ctx.log.close();
        }
        // A real clean makes the scan stale.
        if (!dryRun) scans.delete(String(body.scanId));
        const after = await allDriveSpace();
        return { dryRun, rows, skipped, logFile: ctx.log.file, before, after };
      });
    }

    if (!get && route === '/api/explain') {
      const drive = String(body.drive ?? winPaths().systemDrive);
      if (!/^[a-z]:\\?$/i.test(drive)) throw new HttpError(400, 'drive must look like C:');
      return startJob('explain', `analyzing ${drive}`, async () => {
        const r = await runExplain(ctx, drive);
        const explainId = newId();
        explains.set(explainId, r);
        cap(explains, 2); // each index can be large
        return { explainId, result: r.result };
      });
    }

    let m = /^\/api\/explain\/(\w+)$/.exec(route);
    if (get && m) {
      const e = explains.get(m[1]!);
      if (!e) throw new HttpError(404, 'analysis not found — run it again');
      return e.result;
    }

    m = /^\/api\/tree\/(\w+)$/.exec(route);
    if (get && m) {
      const e = explains.get(m[1]!);
      if (!e) throw new HttpError(404, 'analysis not found — run it again');
      const p = url.searchParams.get('path') || e.index.root;
      const node = findNode(e.index, p);
      if (!node) throw new HttpError(404, 'folder is deeper than the index — open it in Explorer');
      const files = e.index.topFiles
        .filter((f) => samePath(path.dirname(f.path), node.path) || isInside(f.path, node.path))
        .slice(0, 50)
        .map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, mtime: f.mtime }));
      return { root: e.index.root, maxDepth: e.index.maxDepth, node: nodeJson(node, 1, 80), files };
    }

    if (!get && route === '/api/files/delete') {
      if (job) throw new HttpError(409, `busy: ${job.label}`);
      const e = explains.get(String(body.explainId));
      if (!e) throw new HttpError(404, 'analysis not found — run it again');
      const ids = new Set((Array.isArray(body.fileIds) ? body.fileIds : []).map(Number));
      const files = e.index.topFiles.filter((f) => ids.has(f.id));
      if (!files.length) throw new HttpError(400, 'no files selected');
      ctx.log.open('ui-delete-files');
      const results: Array<{ id: number; path: string; ok: boolean; reason?: string }> = [];
      try {
        for (const f of files) {
          const reason = refuseFileDelete(f.path, e.index.root);
          if (reason) {
            results.push({ id: f.id, path: f.path, ok: false, reason });
            ctx.log.warn(`refused ${f.path}: ${reason}`);
            continue;
          }
          // Only delete what was analysed: same size and modified time as in the index.
          const st = await fsp.lstat(f.path).catch(() => undefined);
          if (!st?.isFile() || st.size !== f.bytes || Math.abs(st.mtimeMs - f.mtime) > 1) {
            results.push({ id: f.id, path: f.path, ok: false, reason: 'changed since the analysis' });
            continue;
          }
          const ok = await deleteFile(f.path);
          results.push({ id: f.id, path: f.path, ok, reason: ok ? undefined : 'in use or access denied' });
          ctx.log.info(`${ok ? 'deleted' : 'FAILED'} ${f.path} (${fmtBytes(f.bytes)})`);
          if (ok) e.index.topFiles = e.index.topFiles.filter((x) => x.id !== f.id);
        }
      } finally {
        await ctx.log.close();
        flushLog();
      }
      return { results, logFile: ctx.log.file };
    }

    if (!get && route === '/api/cancel') {
      if (job) requestAbort();
      return { cancelling: !!job };
    }

    if (!get && route === '/api/open') {
      const p = String(body.path ?? '');
      if (!path.isAbsolute(p) || !existsSync(p)) throw new HttpError(400, 'path not found');
      // /select only highlights the item in its folder — it never opens or runs the file.
      await run('explorer.exe', [`/select,${path.normalize(p)}`], 10_000);
      return { ok: true };
    }

    throw new HttpError(404, 'not found');
  }

  // ── HTTP plumbing and access control ──────────────────────────────────────
  const tokenOk = (t: string | undefined) => {
    if (!t) return false;
    const a = Buffer.from(t);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookieToken = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      // DNS rebinding: only our own host names.
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = req.method ?? 'GET';

      if (url.pathname === '/' && method === 'GET') {
        const t = url.searchParams.get('t') ?? undefined;
        if (tokenOk(t)) {
          // Move the token from the URL into a cookie, then drop it from the address bar.
          res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
          return res.end();
        }
        if (!tokenOk(cookieToken(req)))
          return send(403, '<!doctype html><meta charset="utf-8"><title>disk-janitor</title><p style="font:16px system-ui;margin:3em">Open the link printed in the console where <code>disk-janitor ui</code> runs.</p>', 'text/html; charset=utf-8');
        return send(200, page, 'text/html; charset=utf-8');
      }

      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
      if (!tokenOk(cookieToken(req)) && !tokenOk(req.headers['x-dj-token'] as string | undefined)) return send(403, { error: 'forbidden' });

      if (url.pathname === '/api/events' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: job\ndata: ${JSON.stringify(job ?? null)}\n\n`);
        if (job && lastProgress) res.write(`event: progress\ndata: ${JSON.stringify(lastProgress)}\n\n`);
        clients.add(res);
        lastClient = Date.now();
        req.on('close', () => {
          clients.delete(res);
          lastClient = Date.now();
        });
        return;
      }

      let body: Record<string, unknown> = {};
      if (method === 'POST') {
        // CSRF: same-origin JSON only.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return send(403, { error: 'bad origin' });
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON only' });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) {
          size += (ch as Buffer).length;
          if (size > 1024 * 1024) return send(413, { error: 'too large' });
          chunks.push(ch as Buffer);
        }
        try {
          body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
      } else if (method !== 'GET') return send(405, { error: 'method not allowed' });

      send(200, await api(method, url.pathname, url, body));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(status, { error: (e as Error).message });
    }
  });

  const stop = (why: string) => {
    ctx.log.sink = undefined;
    console.log(why);
    close();
    process.exit(0);
  };
  const idle = setInterval(() => {
    if (job || clients.size) return;
    if (opts.exitWhenClosedMs && lastClient && Date.now() - lastClient > opts.exitWhenClosedMs) stop('The browser window was closed — stopping.');
    if (Date.now() - lastActivity > IDLE_MS) stop('Idle for 30 minutes — stopping.');
  }, 10_000);

  function close() {
    clearInterval(logTimer);
    clearInterval(ping);
    clearInterval(idle);
    offProgress();
    for (const c of clients) c.end();
    server.close();
  }

  const listen = () =>
    new Promise<{ port: number; url: string }>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve({ port, url: `http://127.0.0.1:${port}/?t=${token}` });
      });
    });

  return { server, listen, close, token };
}

/** Why a single file picked in Explore must not be deleted (undefined = fine). */
export function refuseFileDelete(file: string, driveRoot: string): string | undefined {
  const w = winPaths();
  if (!isSafeTarget(file, driveRoot)) return 'protected location (System32, WinSxS, Installer, Program Files)';
  if (samePath(path.dirname(file), driveRoot) && /\.sys$/i.test(file)) return 'system file (pagefile / hiberfil / swapfile)';
  if (isInside(file, w.systemRoot)) return 'inside the Windows folder — use a category instead';
  if (/\\system volume information\\/i.test(file)) return 'System Volume Information';
  return undefined;
}

/** Browsers that can open the UI as a plain app window (no tabs or address bar). */
function appBrowser(): string | undefined {
  const e = process.env;
  const roots = [e['ProgramFiles(x86)'], e.ProgramFiles, e.LOCALAPPDATA].filter((r): r is string => !!r);
  for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'])
    for (const r of roots) {
      const exe = path.join(r, rel);
      if (existsSync(exe)) return exe;
    }
  return undefined;
}

/** Open the UI: an Edge/Chrome app window when available, otherwise the default browser. */
export async function openBrowser(url: string): Promise<boolean> {
  const exe = appBrowser();
  if (exe) {
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(exe, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' });
      p.once('error', () => resolve(false));
      p.once('spawn', () => resolve(true));
      p.unref();
    });
    if (ok) return true;
  }
  // explorer.exe hands the URL to the default browser.
  const r = await run('explorer.exe', [url], 10_000);
  return r.code <= 1; // explorer exits with 1 even when it worked
}

export async function cmdUi(ctx: Ctx, opts: { port: number; open: boolean; exitWhenClosed?: boolean }): Promise<number> {
  const ui = createUiServer(ctx, { port: opts.port, exitWhenClosedMs: opts.open && opts.exitWhenClosed ? 2 * 60_000 : undefined });
  const { url } = await ui.listen();
  console.log(`disk-janitor UI: ${url}`);
  console.log('Only reachable from this machine. Keep this window open; Ctrl+C stops it.');
  if (!ctx.admin) console.log('Not elevated — system folders will be partly unreadable and admin-only categories cannot be cleaned.');
  if (opts.open) {
    const opened = await openBrowser(url);
    console.log(opened ? 'Opened in your browser. Nothing showed up? Paste the link above into a browser on this machine.' : 'Could not start a browser — paste the link above into a browser on this machine.');
    if (opts.exitWhenClosed) console.log('Closing the disk-janitor browser window also stops this program.');
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      requestAbort();
      ui.close();
      resolve();
    });
  });
  return 0;
}
