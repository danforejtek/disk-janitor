import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtBytes, fmtDate } from '../lib/format';
import { deleteTree, isInside, isSafeTarget, rejectCustomRoot, samePath, trimActiveLog } from '../lib/fsops';
import { isAborted, progress } from '../lib/progress';
import { fixedDrives, runShell, userProfiles, which } from '../lib/sys';
import { measure, walk } from '../lib/walk';
import { existingRoots, fileSet, newestTime } from './fileset';
import { emptyClean, emptyScan, type Category, type Ctx, type Item, type ScanResult } from './types';

const perProfile = async (...rel: string[]) => (await userProfiles()).map((p) => path.join(p, ...rel));

/** Folder names never searched for projects: OS dirs, global tool installs, editor extensions. */
const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'program files',
  'program files (x86)', 'windowsapps', 'appdata', 'nodejs', 'nvm', 'nvm4w', 'volta', 'fnm', 'scoop',
]);

const PROJECT_MARKERS = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const NM_MARKERS = ['.modules.yaml', '.package-lock.json', '.yarn-state.yml', '.yarn-integrity'];

async function mtime(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Last time a project's dependencies were installed or its manifest/lockfile touched. */
async function lastUsed(nodeModules: string): Promise<number> {
  const project = path.dirname(nodeModules);
  const times = await Promise.all([
    mtime(nodeModules),
    ...NM_MARKERS.map((m) => mtime(path.join(nodeModules, m))),
    ...PROJECT_MARKERS.map((m) => mtime(path.join(project, m))),
  ]);
  return Math.max(...times);
}

export interface NodeProject {
  /** The project's node_modules folder. */
  nodeModules: string;
  /** Last install / manifest change. */
  used: number;
}

let projectsCache: { key: string; result: Promise<{ projects: NodeProject[]; errors: number }> } | undefined;

/** Every project node_modules under searchRoots (or all fixed drives). One walk per run, shared by node-modules and browser-cache. */
export function findNodeProjects(ctx: Ctx): Promise<{ projects: NodeProject[]; errors: number }> {
  const key = ctx.options.searchRoots.join('|');
  if (projectsCache?.key === key) return projectsCache.result;
  const result = (async () => {
    const roots = ctx.options.searchRoots.length ? ctx.options.searchRoots : await fixedDrives();
    const projects: NodeProject[] = [];
    let errors = 0;
    for (const root of await existingRoots(roots)) {
      progress.start(`searching node projects in ${root}`);
      const w = await walk(root, {
        onDir: async (dir, name) => {
          const n = name.toLowerCase();
          if (n !== 'node_modules') return !SKIP_DIRS.has(n) && !n.startsWith('.');
          // A project folder, not a global prefix or random vendored copy.
          if (!(await mtime(path.join(path.dirname(dir), 'package.json')))) return false;
          projects.push({ nodeModules: dir, used: await lastUsed(dir) });
          return false; // never descend into node_modules
        },
      });
      progress.done();
      errors += w.errors;
    }
    return { projects, errors };
  })();
  projectsCache = { key, result };
  return result;
}

const nodeModules: Category = {
  id: 'node-modules',
  group: 'node',
  title: 'Stale node_modules',
  description: 'node_modules of projects not installed/touched for N days (searchRoots or all fixed drives). Run `pnpm install` / `npm ci` to restore.',
  risk: 'moderate',
  async scan(ctx): Promise<ScanResult> {
    const res = emptyScan();
    const cutoff = Date.now() - ctx.options.nodeModulesAgeDays * 86_400_000;
    const { projects, errors } = await findNodeProjects(ctx);
    res.errors += errors;
    const found = projects.filter((p) => p.used <= cutoff).map((p) => ({ path: p.nodeModules, used: p.used }));
    const active = projects.length - found.length;

    for (const f of found) {
      if (isAborted()) break;
      progress.start(`node-modules: measuring ${f.path}`);
      const m = await measure(f.path);
      progress.done();
      const item: Item = { path: f.path, bytes: m.bytes, linkedBytes: m.linkedBytes, files: m.files, detail: `last used ${fmtDate(f.used)}` };
      if (m.linkedBytes) item.detail += `, ${fmtBytes(m.linkedBytes)} hard-linked to pnpm store`;
      res.items.push(item);
      res.bytes += m.bytes - m.linkedBytes;
      res.files += m.files;
    }
    res.items.sort((a, b) => b.bytes - a.bytes);
    res.notes.push(`${found.length} stale (>${ctx.options.nodeModulesAgeDays} days), ${active} recently used left alone`);
    if (res.items.some((i) => i.linkedBytes))
      res.notes.push('hard-linked bytes are only freed by `pnpm-store` prune afterwards (it runs after this one)');
    return res;
  },
  async clean(ctx, scan) {
    const res = emptyClean();
    for (const item of scan.items) {
      if (isAborted()) break;
      // Re-validate: still a node_modules folder inside a project.
      if (path.basename(item.path).toLowerCase() !== 'node_modules' || !(await mtime(path.join(path.dirname(item.path), 'package.json')))) {
        ctx.log.warn(`skipped (no longer looks like a project node_modules): ${item.path}`);
        continue;
      }
      if (ctx.dryRun) {
        ctx.log.debug(`[dry-run] ${item.path} (${fmtBytes(item.bytes)})`);
      } else {
        progress.start(`node-modules: deleting ${item.path}`);
        const ok = await deleteTree(item.path);
        progress.done();
        if (!ok) {
          res.failed++;
          ctx.log.debug(`failed ${item.path}`);
          continue;
        }
        ctx.log.debug(`deleted ${item.path} (${fmtBytes(item.bytes)})`);
      }
      res.deleted++;
      res.freedBytes += item.bytes - (item.linkedBytes ?? 0);
    }
    if (res.failed) res.notes.push(`${res.failed} folders could not be fully removed (files in use?)`);
    return res;
  },
};

async function findPnpmStores(ctx: Ctx): Promise<string[]> {
  const candidates = [
    ...ctx.options.pnpmStores,
    ...(await fixedDrives()).map((d) => `${d}.pnpm-store`),
    ...(await perProfile('AppData', 'Local', 'pnpm', 'store')),
  ];
  const pnpm = await which('pnpm');
  if (pnpm) {
    const r = await runShell(`"${pnpm}" store path`, 30_000);
    const p = r.stdout.trim().split(/\r?\n/).pop();
    // `store path` returns …\store\v10 — the store root is its parent.
    if (r.code === 0 && p) candidates.push(/[\\/]v\d+$/.test(p) ? path.dirname(p) : p);
  }
  const roots = await existingRoots(candidates);
  // Drop nested duplicates.
  return roots.filter((r) => !roots.some((o) => !samePath(o, r) && isInside(r, o)));
}

const pnpmStore: Category = {
  id: 'pnpm-store',
  group: 'node',
  title: 'pnpm store (unreferenced packages)',
  description: 'Runs `pnpm store prune` on every pnpm store found (per drive and per profile). Requires pnpm on PATH.',
  risk: 'safe',
  async scan(ctx): Promise<ScanResult> {
    const res = emptyScan();
    for (const store of await findPnpmStores(ctx)) {
      progress.start(`pnpm-store: ${store}`);
      const m = await measure(store);
      progress.done();
      res.errors += m.walk.errors;
      const unreferenced = m.bytes - m.linkedBytes;
      res.items.push({ path: store, bytes: unreferenced, files: m.files, detail: `total ${fmtBytes(m.bytes)}, ${fmtBytes(m.linkedBytes)} in use` });
      res.bytes += unreferenced;
      res.files += m.files;
    }
    if (!(await which('pnpm')) && res.items.length) res.notes.push('pnpm not on PATH — cleaning will be skipped');
    res.notes.push('unreferenced = files not hard-linked by any node_modules (what prune removes)');
    return res;
  },
  async clean(ctx, scan) {
    const res = emptyClean();
    const pnpm = await which('pnpm');
    if (!pnpm) return { ...res, notes: ['pnpm not found on PATH — skipped (install pnpm or delete the store folder manually)'] };
    for (const item of scan.items) {
      const cmd = `"${pnpm}" store prune --store-dir "${item.path}"`;
      if (ctx.dryRun) {
        ctx.log.debug(`[dry-run] ${cmd}`);
        res.freedBytes += item.bytes;
        res.deleted++;
        continue;
      }
      progress.start(`pnpm-store: pruning ${item.path}`);
      // Re-measure first: node-modules may have just orphaned more packages.
      const pre = await measure(item.path);
      const r = await runShell(cmd);
      progress.done();
      ctx.log.debug(`${cmd}\n${r.stdout}${r.stderr}`);
      if (r.code !== 0) {
        res.failed++;
        res.notes.push(`prune failed for ${item.path}: ${r.stderr.trim().split(/\r?\n/).pop() ?? `exit ${r.code}`}`);
        continue;
      }
      const post = await measure(item.path);
      res.freedBytes += Math.max(0, pre.bytes - post.bytes);
      res.deleted++;
    }
    return res;
  },
};

const pkgCache = (id: string, title: string, rels: string[][]) =>
  fileSet({
    id,
    group: 'node',
    title,
    description: `Deletes the cache folder contents for every profile: ${rels.map((r) => r.join('\\')).join(', ')}.`,
    risk: 'safe',
    roots: async () => (await Promise.all(rels.map((r) => perProfile(...r)))).flat(),
    minAgeDays: () => 0,
  });

export function devCategories(): Category[] {
  return [
    nodeModules, // before pnpm-store so its prune picks up what was just orphaned
    pnpmStore,
    pkgCache('pnpm-cache', 'pnpm metadata cache', [['AppData', 'Local', 'pnpm-cache']]),
    pkgCache('npm-cache', 'npm cache', [['AppData', 'Local', 'npm-cache'], ['AppData', 'Roaming', 'npm-cache']]),
    pkgCache('yarn-cache', 'Yarn cache', [['AppData', 'Local', 'Yarn', 'Cache'], ['AppData', 'Local', 'Yarn', 'Berry', 'cache']]),
    pkgCache('node-gyp-cache', 'node-gyp headers cache', [['AppData', 'Local', 'node-gyp', 'Cache']]),
  ];
}

export function customCategories(ctx: Ctx): Category[] {
  return ctx.options.custom.flatMap((c, i) => {
    const reason = rejectCustomRoot(c.path);
    if (reason) {
      ctx.log.warn(`config: custom path "${c.path}" ignored — ${reason}`);
      return [];
    }
    const re = c.pattern ? new RegExp(c.pattern, 'i') : undefined;
    const base = fileSet({
      id: c.id ?? `custom-${i + 1}`,
      group: 'custom',
      title: 'Custom path (config)',
      description: `${c.path} — files${re ? ` matching /${c.pattern}/` : ''} older than ${c.olderThanDays ?? 0} days${c.truncateOverMb ? `; newer ones over ${c.truncateOverMb} MB are trimmed` : ''}.`,
      risk: 'moderate',
      roots: () => [c.path],
      minAgeDays: () => c.olderThanDays ?? 0,
      match: re ? (n) => re.test(n) : undefined,
    });
    return [c.truncateOverMb ? withTrim(base, c.path, c.truncateOverMb, c.olderThanDays ?? 0, re) : base];
  });
}

/** Add "trim files over N MB that are too new to delete" to a fileSet category (logs nobody rotates). */
function withTrim(base: Category, root: string, overMb: number, ageDays: number, re?: RegExp): Category {
  return {
    ...base,
    async scan(ctx) {
      const res = await base.scan(ctx);
      const cutoff = Date.now() - ageDays * 86_400_000;
      const keep = ctx.options.logKeepMb * 1024 ** 2;
      await walk(root, {
        onFile: (f, st) => {
          if (st.size <= overMb * 1024 ** 2 || (re && !re.test(path.basename(f)))) return;
          if (newestTime(st) <= cutoff) return; // old enough: the base category deletes it
          res.items.push({ path: f, root, bytes: st.size - keep, action: 'trim', detail: `${fmtBytes(st.size)} → keep last ${fmtBytes(keep)}` });
          res.bytes += st.size - keep;
        },
      });
      return res;
    },
    async clean(ctx, scan) {
      const res = await base.clean!(ctx, { ...scan, items: scan.items.filter((i) => i.action !== 'trim') });
      const keep = ctx.options.logKeepMb * 1024 ** 2;
      for (const item of scan.items.filter((i) => i.action === 'trim')) {
        if (isAborted()) break;
        if (!isSafeTarget(item.path, root)) continue;
        if (ctx.dryRun) {
          res.deleted++;
          res.freedBytes += item.bytes;
          ctx.log.debug(`[dry-run] trim ${item.path}`);
          continue;
        }
        const r = await trimActiveLog(item.path, keep);
        if (r) {
          res.deleted++;
          res.freedBytes += r.freed;
          ctx.log.debug(`trimmed ${item.path} (−${fmtBytes(r.freed)})`);
        } else res.failed++;
      }
      return res;
    },
  };
}


export function resetNodeProjects() {
  projectsCache = undefined;
}
