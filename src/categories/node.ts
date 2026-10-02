import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtBytes, fmtDate } from '../lib/format';
import { deleteTree, isSafeTarget } from '../lib/fsops';
import { isAborted, progress } from '../lib/progress';
import { isWindows, run, userProfiles, winPaths } from '../lib/sys';
import { measure, walk } from '../lib/walk';
import { findNodeProjects } from './dev';
import { existingRoots } from './fileset';
import { logSet, type LogFiles } from './logset';
import { emptyClean, emptyScan, type Category, type Ctx, type Item, type ScanResult } from './types';

const perProfile = async (...rel: string[]) => (await userProfiles()).map((p) => path.join(p, ...rel));

/** A machine-wide environment variable (what services such as pm2 started by a Windows service see). */
async function machineEnv(name: string): Promise<string | undefined> {
  if (!isWindows) return undefined;
  const r = await run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', name], 10_000);
  const m = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, 'i').exec(r.stdout);
  return m?.[1]?.trim();
}

// ── pm2 ──────────────────────────────────────────────────────────────────────

/** Log paths of every app in a pm2 `dump.pm2` (what `pm2 save` writes). */
export function pm2DumpLogs(json: string): string[] {
  let procs: unknown;
  try {
    procs = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(procs)) return [];
  const out: string[] = [];
  for (const p of procs as Array<Record<string, unknown>>) {
    for (const k of ['pm_out_log_path', 'pm_err_log_path', 'pm_log_path']) {
      const v = p?.[k];
      if (typeof v === 'string' && path.isAbsolute(v) && !/^(nul|\/dev\/null)$/i.test(v)) out.push(path.normalize(v));
    }
  }
  return out;
}

/** pm2's own active log names: <app>-out.log, <app>-error-3.log, pm2.log. Rotated copies (pm2-logrotate: <name>__<date>.log) don't match. */
const PM2_ACTIVE = /^(?!.*__).+-(out|error|err)(-\d+)?\.log$/i;

export async function pm2Homes(ctx: Ctx): Promise<string[]> {
  const w = winPaths();
  const candidates = [
    ...ctx.options.pm2Homes,
    process.env.PM2_HOME,
    await machineEnv('PM2_HOME'),
    ...(await perProfile('.pm2')),
    path.join(w.programData, 'pm2', 'home'),
    path.join(w.programData, 'pm2'),
    `${w.systemDrive}\\etc\\.pm2`,
  ].filter((p): p is string => !!p);
  const homes = await existingRoots(candidates);
  return homes.filter((h) => ['logs', 'dump.pm2', 'pm2.log'].some((m) => existsSync(path.join(h, m))));
}

async function findPm2Logs(ctx: Ctx): Promise<LogFiles> {
  const out: LogFiles = { active: [], dirs: [], notes: [] };
  const homes = await pm2Homes(ctx);
  if (!homes.length) {
    out.notes.push('no pm2 home found (set pm2Homes in the config if PM2_HOME is unusual)');
    return out;
  }
  for (const home of homes) {
    const logs = path.join(home, 'logs');
    out.dirs.push(logs);
    out.active.push(path.join(home, 'pm2.log'));
    for (const e of await fsp.readdir(logs, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && PM2_ACTIVE.test(e.name)) out.active.push(path.join(logs, e.name));
    }
    const dump = await fsp.readFile(path.join(home, 'dump.pm2'), 'utf8').catch(() => '');
    for (const f of pm2DumpLogs(dump)) {
      out.active.push(f);
      if (!out.dirs.some((d) => d.toLowerCase() === path.dirname(f).toLowerCase())) out.dirs.push(path.dirname(f));
    }
  }
  out.active = [...new Map(out.active.map((f) => [f.toLowerCase(), f])).values()];
  out.notes.push(`pm2 homes: ${homes.join(', ')}`);
  out.notes.push('lasting fix: `pm2 install pm2-logrotate` (rotates and caps logs)');
  return out;
}

const pm2Logs = logSet({
  id: 'pm2-logs',
  group: 'node',
  title: 'pm2 logs',
  description: 'Logs of pm2-managed Node apps (every PM2_HOME, custom paths from dump.pm2). Active logs are trimmed, old rotated ones deleted.',
  risk: 'safe',
  find: findPm2Logs,
});

// ── Puppeteer / Playwright browsers ──────────────────────────────────────────

/** Browser builds pinned by an installed puppeteer-core (revisions.js). */
export function parsePuppeteerRevisions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/['"]?(chrome|chrome-headless-shell|firefox|chromium)['"]?\s*:\s*['"]([^'"]+)['"]/g)) out.push(`${m[1]}/${m[2]}`);
  return out;
}

/** Browser builds pinned by an installed playwright-core (browsers.json) as folder names (chromium-1140). */
export function parsePlaywrightBrowsers(src: string): string[] {
  try {
    const j = JSON.parse(src) as { browsers?: Array<{ name?: string; revision?: string }> };
    return (j.browsers ?? []).filter((b) => b.name && b.revision).map((b) => `${b.name!.replace(/-/g, '_')}-${b.revision}`);
  } catch {
    return [];
  }
}

/** Compare dotted versions / revisions numerically ("131.0.6778.204" > "130.0.1"). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface BrowserBuild {
  path: string;
  /** chrome, chrome-headless-shell, chromium (playwright), … */
  browser: string;
  version: string;
  /** Cache folder it lives in — the newest build is kept per cache and browser. */
  cache?: string;
}

/**
 * Which builds can go: everything except the pinned ones and the newest of each browser.
 * `pinned` holds "browser/version" (puppeteer) or folder names (playwright).
 */
export function removableBuilds(builds: BrowserBuild[], pinned: Set<string>): BrowserBuild[] {
  const byBrowser = new Map<string, BrowserBuild[]>();
  for (const b of builds) {
    const key = `${(b.cache ?? '').toLowerCase()}|${b.browser}`;
    byBrowser.set(key, [...(byBrowser.get(key) ?? []), b]);
  }
  const out: BrowserBuild[] = [];
  for (const list of byBrowser.values()) {
    const newest = [...list].sort((a, b) => cmpVersion(b.version, a.version))[0];
    for (const b of list) {
      if (b === newest) continue;
      if (pinned.has(`${b.browser}/${b.version}`) || pinned.has(path.basename(b.path).toLowerCase())) continue;
      out.push(b);
    }
  }
  return out;
}

async function dirs(p: string): Promise<string[]> {
  return (await fsp.readdir(p, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => path.join(p, e.name));
}

async function browserBuilds(ctx: Ctx): Promise<{ builds: BrowserBuild[]; roots: string[] }> {
  const puppeteerRoots = await existingRoots([
    ...(process.env.PUPPETEER_CACHE_DIR ? [process.env.PUPPETEER_CACHE_DIR] : []),
    ...(await perProfile('.cache', 'puppeteer')),
  ]);
  const playwrightRoots = await existingRoots([
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH && path.isAbsolute(process.env.PLAYWRIGHT_BROWSERS_PATH) ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    ...(await perProfile('AppData', 'Local', 'ms-playwright')),
  ]);
  void ctx;
  const builds: BrowserBuild[] = [];
  // Puppeteer: <cache>\<browser>\<platform>-<buildId>
  for (const root of puppeteerRoots) {
    for (const bdir of await dirs(root)) {
      for (const v of await dirs(bdir)) {
        const m = /^[a-z0-9]+-(.+)$/i.exec(path.basename(v));
        if (m?.[1]) builds.push({ path: v, browser: `puppeteer:${path.basename(bdir).toLowerCase()}`, version: m[1], cache: root });
      }
    }
  }
  // Playwright: <cache>\<browser>-<revision>
  for (const root of playwrightRoots) {
    for (const v of await dirs(root)) {
      const m = /^(.+)-(\d+)$/.exec(path.basename(v));
      if (m?.[1] && m[2]) builds.push({ path: v, browser: `playwright:${m[1].toLowerCase()}`, version: m[2], cache: root });
    }
  }
  return { builds, roots: [...puppeteerRoots, ...playwrightRoots] };
}

/** Browser builds referenced by installed puppeteer-core / playwright-core in any project found. */
async function pinnedBuilds(ctx: Ctx): Promise<Set<string>> {
  const pinned = new Set<string>();
  const { projects } = await findNodeProjects(ctx);
  for (const p of projects) {
    const nm = p.nodeModules;
    const pkgDirs = [path.join(nm, 'puppeteer-core'), path.join(nm, 'puppeteer', 'node_modules', 'puppeteer-core'), path.join(nm, 'playwright-core')];
    // pnpm keeps them under .pnpm\<name>@<version>\node_modules\<name>
    for (const d of await fsp.readdir(path.join(nm, '.pnpm')).catch(() => [] as string[])) {
      if (d.startsWith('puppeteer-core@')) pkgDirs.push(path.join(nm, '.pnpm', d, 'node_modules', 'puppeteer-core'));
      if (d.startsWith('playwright-core@')) pkgDirs.push(path.join(nm, '.pnpm', d, 'node_modules', 'playwright-core'));
    }
    for (const d of pkgDirs) {
      const rev = await fsp.readFile(path.join(d, 'lib', 'cjs', 'puppeteer', 'revisions.js'), 'utf8').catch(() => '');
      for (const r of parsePuppeteerRevisions(rev)) pinned.add(`puppeteer:${r}`);
      const bj = await fsp.readFile(path.join(d, 'browsers.json'), 'utf8').catch(() => '');
      for (const f of parsePlaywrightBrowsers(bj)) pinned.add(f.toLowerCase());
    }
  }
  return pinned;
}

/** Profiles Puppeteer/Playwright create in %TEMP% and leave behind when a browser isn't closed. */
const LEAKED_PROFILE = /^(puppeteer_dev_(chrome|firefox)_profile-|playwright_(chromium|firefox|webkit)dev_profile-|playwright-artifacts-)/i;

async function newestIn(dir: string): Promise<number> {
  let newest = 0;
  await walk(dir, { onFile: (_f, st) => void (newest = Math.max(newest, st.mtimeMs, st.birthtimeMs)) });
  return newest || (await fsp.stat(dir).then((s) => s.mtimeMs).catch(() => 0));
}

const browserCache: Category = {
  id: 'browser-cache',
  group: 'node',
  title: 'Puppeteer / Playwright browsers',
  description:
    'Old Chrome/Firefox builds in .cache\\puppeteer and ms-playwright (keeps the newest and every build an installed puppeteer-core/playwright-core pins) plus leaked browser profiles in Temp.',
  risk: 'moderate',
  async scan(ctx): Promise<ScanResult> {
    const res = emptyScan();
    const { builds, roots } = await browserBuilds(ctx);
    const pinned = builds.length > 1 ? await pinnedBuilds(ctx) : new Set<string>();
    const add = (item: Item) => {
      res.items.push(item);
      res.bytes += item.bytes;
      res.files += item.files ?? 0;
    };
    for (const b of removableBuilds(builds, pinned)) {
      if (isAborted()) break;
      progress.start(`browser-cache: ${b.path}`);
      const m = await measure(b.path);
      progress.done();
      add({ path: b.path, root: path.dirname(b.path), bytes: m.bytes, files: m.files, action: 'tree', detail: `${b.browser.split(':')[1]} ${b.version}` });
    }

    const cutoff = Date.now() - 86_400_000;
    const temps = await existingRoots([`${winPaths().systemRoot}\\Temp`, ...(await perProfile('AppData', 'Local', 'Temp'))]);
    let leaked = 0;
    for (const t of temps) {
      for (const d of await dirs(t)) {
        if (isAborted()) break;
        if (!LEAKED_PROFILE.test(path.basename(d))) continue;
        const newest = await newestIn(d);
        if (newest > cutoff) continue;
        const m = await measure(d);
        if (!m.bytes) continue; // empty leftovers aren't worth a row
        leaked++;
        add({ path: d, root: t, bytes: m.bytes, files: m.files, action: 'tree', detail: `leaked browser profile, last used ${fmtDate(newest)}` });
      }
    }
    res.items.sort((a, b) => b.bytes - a.bytes);
    if (roots.length) res.notes.push(`${builds.length} browser builds found, ${pinned.size} pinned by installed packages`);
    if (leaked) res.notes.push(`${leaked} leaked profiles — the app launching the browser is not calling browser.close()`);
    res.notes.push('a removed build is downloaded again by `npx puppeteer browsers install` / `npx playwright install`');
    return res;
  },
  async clean(ctx, scan) {
    const res = emptyClean();
    for (const item of scan.items) {
      if (isAborted()) break;
      if (!item.root || !isSafeTarget(item.path, item.root)) {
        ctx.log.warn(`refused (outside root or protected): ${item.path}`);
        continue;
      }
      if (ctx.dryRun) ctx.log.debug(`[dry-run] ${item.path} (${fmtBytes(item.bytes)})`);
      else {
        progress.start(`browser-cache: deleting ${item.path}`);
        const ok = await deleteTree(item.path);
        progress.done();
        if (!ok) {
          res.failed++;
          ctx.log.debug(`failed (in use?) ${item.path}`);
          continue;
        }
        ctx.log.debug(`deleted ${item.path} (${fmtBytes(item.bytes)})`);
      }
      res.deleted++;
      res.freedBytes += item.bytes;
    }
    if (res.failed) res.notes.push(`${res.failed} folders in use (browser still running?)`);
    return res;
  },
};

export function nodeCategories(): Category[] {
  return [pm2Logs, browserCache];
}
