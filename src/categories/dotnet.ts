import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtBytes, fmtDate } from '../lib/format';
import { deleteTree, isSafeTarget } from '../lib/fsops';
import { isAborted, progress } from '../lib/progress';
import { asArray, fixedDrives, isWindows, powershellJson, run, userProfiles, which, winPaths } from '../lib/sys';
import { measure, walk } from '../lib/walk';
import { existingRoots, fileSet } from './fileset';
import { emptyClean, emptyScan, type Category, type Ctx, type Item, type ScanResult } from './types';

const perProfile = async (...rel: string[]) => (await userProfiles()).map((p) => path.join(p, ...rel));

// ── NuGet ────────────────────────────────────────────────────────────────────

const nugetCache = fileSet({
  id: 'nuget-cache',
  group: 'dotnet',
  title: 'NuGet caches',
  description: 'Global packages (.nuget\\packages or NUGET_PACKAGES), v3-cache, plugins-cache and NuGetScratch for every profile. Restored on the next build — don\'t run during builds.',
  risk: 'safe',
  roots: async () => [
    ...(process.env.NUGET_PACKAGES ? [process.env.NUGET_PACKAGES] : []),
    ...(await perProfile('.nuget', 'packages')),
    ...(await perProfile('AppData', 'Local', 'NuGet', 'v3-cache')),
    ...(await perProfile('AppData', 'Local', 'NuGet', 'plugins-cache')),
    ...(await perProfile('AppData', 'Local', 'Temp', 'NuGetScratch')),
  ],
  minAgeDays: () => 0,
});

// ── .NET SDKs / runtimes ─────────────────────────────────────────────────────

export interface DotnetInstall {
  kind: 'sdk' | 'runtime';
  /** SDK, or runtime name such as Microsoft.NETCore.App. */
  name: string;
  version: string;
  dir: string;
}

/** Parse `dotnet --list-sdks` / `--list-runtimes` lines: "8.0.404 [C:\Program Files\dotnet\sdk]". */
export function parseDotnetList(out: string, kind: 'sdk' | 'runtime'): DotnetInstall[] {
  const res: DotnetInstall[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = kind === 'sdk' ? /^(\S+)\s+\[(.+)\]$/.exec(line.trim()) : /^(\S+)\s+(\S+)\s+\[(.+)\]$/.exec(line.trim());
    if (!m) continue;
    if (kind === 'sdk') res.push({ kind, name: 'SDK', version: m[1]!, dir: path.join(m[2]!, m[1]!) });
    else res.push({ kind, name: m[1]!, version: m[2]!, dir: path.join(m[3]!, m[2]!) });
  }
  return res;
}

const verNums = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);

/**
 * Superseded installs: for SDKs every version but the newest of its feature band (8.0.1xx),
 * for runtimes every version but the newest of its name + major.minor. Previews count like releases.
 */
export function supersededDotnet(list: DotnetInstall[]): DotnetInstall[] {
  const group = (d: DotnetInstall) => {
    const [maj, min, patch] = verNums(d.version);
    return d.kind === 'sdk' ? `sdk ${maj}.${min}.${Math.floor((patch ?? 0) / 100)}xx` : `${d.name} ${maj}.${min}`;
  };
  const groups = new Map<string, DotnetInstall[]>();
  for (const d of list) groups.set(group(d), [...(groups.get(group(d)) ?? []), d]);
  const out: DotnetInstall[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => {
      const pa = verNums(a.version);
      const pb = verNums(b.version);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      return 0;
    });
    out.push(...sorted.slice(1));
  }
  return out;
}

const dotnetSdks: Category = {
  id: 'dotnet-sdks',
  group: 'dotnet',
  title: '.NET SDKs and runtimes',
  description: 'Installed SDKs/runtimes; older patch versions of the same feature band are superseded. Remove with dotnet-core-uninstall or Settings › Apps.',
  risk: 'caution',
  reportOnly: true,
  async scan(): Promise<ScanResult> {
    const res = emptyScan();
    const exes = new Set<string>();
    const w = winPaths();
    for (const p of [path.join(w.programFiles, 'dotnet', 'dotnet.exe'), path.join(w.programFilesX86, 'dotnet', 'dotnet.exe')]) if (existsSync(p)) exes.add(p);
    const onPath = await which('dotnet');
    if (onPath) exes.add(onPath);
    const all: DotnetInstall[] = [];
    for (const exe of exes) {
      all.push(...parseDotnetList((await run(exe, ['--list-sdks'], 30_000)).stdout, 'sdk'));
      all.push(...parseDotnetList((await run(exe, ['--list-runtimes'], 30_000)).stdout, 'runtime'));
    }
    const unique = [...new Map(all.map((d) => [d.dir.toLowerCase(), d])).values()];
    const old = new Set(supersededDotnet(unique).map((d) => d.dir.toLowerCase()));
    for (const d of unique) {
      if (!old.has(d.dir.toLowerCase())) continue;
      const m = await measure(d.dir);
      res.items.push({ path: d.dir, bytes: m.bytes, files: m.files, detail: `${d.name} ${d.version} — superseded` });
      res.bytes += m.bytes;
      res.files += m.files;
    }
    res.items.sort((a, b) => b.bytes - a.bytes);
    if (unique.length) res.notes.push(`${unique.filter((d) => d.kind === 'sdk').length} SDKs, ${unique.filter((d) => d.kind === 'runtime').length} runtimes installed`);
    if (res.items.length) res.notes.push('check global.json pins first; then `dotnet-core-uninstall remove --all-but-latest --sdk` (aka.ms/dotnet-core-uninstall)');
    return res;
  },
};

// ── Build agents (Azure DevOps agent, GitHub Actions runner) ─────────────────

export interface Agent {
  root: string;
  work: string;
  kind: 'azure-devops' | 'github-runner';
}

interface SvcInfo {
  Name?: string;
  PathName?: string;
}

const AGENT_PS = `@(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'vstsagent*' -or $_.Name -like 'azpipelines*' -or $_.Name -like 'actions.runner*' } | Select-Object Name, PathName) | ConvertTo-Json -Compress`;

/** Agent folder → its work folder, read from .agent / .runner (workFolder may be relative or absolute). */
export async function readAgent(root: string): Promise<Agent | undefined> {
  for (const [file, kind] of [['.agent', 'azure-devops'], ['.runner', 'github-runner']] as const) {
    const raw = await fsp.readFile(path.join(root, file), 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    let work = '_work';
    try {
      // .runner files start with a BOM.
      work = (JSON.parse(raw.replace(/^\uFEFF/, '')) as { workFolder?: string }).workFolder || '_work';
    } catch {
      /* default */
    }
    return { root, work: path.resolve(root, work), kind };
  }
  return undefined;
}

let agentsCache: Promise<Agent[]> | undefined;
export function findAgents(ctx: Ctx): Promise<Agent[]> {
  return (agentsCache ??= (async () => {
    const roots = new Set<string>(ctx.options.agentRoots);
    if (isWindows) {
      for (const s of asArray(await powershellJson<SvcInfo | SvcInfo[]>(AGENT_PS, 60_000))) {
        const exe = (s.PathName ?? '').replace(/^"([^"]+)".*$/, '$1').trim();
        // <root>\bin\AgentService.exe / RunnerService.exe
        if (exe) roots.add(path.dirname(path.dirname(exe)));
      }
      for (const d of await fixedDrives()) {
        for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory() || !/^(agent|azagent|vsts|ado|actions-runner|runner|build)/i.test(e.name)) continue;
          const p = path.join(d, e.name);
          roots.add(p);
          // azagent\A1, agents\agent1 …
          for (const sub of await fsp.readdir(p, { withFileTypes: true }).catch(() => [])) if (sub.isDirectory()) roots.add(path.join(p, sub.name));
        }
      }
    }
    const out: Agent[] = [];
    for (const r of await existingRoots([...roots])) {
      const a = await readAgent(r);
      if (a) out.push(a);
    }
    return out;
  })());
}

const agentDiag = fileSet({
  id: 'agent-diag',
  group: 'dotnet',
  title: 'Build agent logs and temp',
  description: 'Azure DevOps agent / GitHub runner _diag logs and _work\\_temp files older than --log-age.',
  risk: 'safe',
  roots: async (ctx) => (await findAgents(ctx)).flatMap((a) => [path.join(a.root, '_diag'), path.join(a.work, '_temp')]),
  minAgeDays: (ctx) => ctx.options.logAgeDays,
});

/** Work folders the agent re-creates: ADO numbered build dirs, runner repo dirs. Never _tool, _tasks, _actions, SourceRootMapping. */
export function isBuildDir(agent: Agent['kind'], name: string): boolean {
  if (agent === 'azure-devops') return /^\d+$/.test(name);
  return !name.startsWith('_');
}

async function newestIn(dir: string): Promise<number> {
  let newest = 0;
  await walk(dir, { onFile: (_f, st) => void (newest = Math.max(newest, st.mtimeMs, st.birthtimeMs)) });
  return newest;
}

async function workerRunning(): Promise<boolean> {
  if (!isWindows) return false;
  const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], 30_000);
  return /"(Agent\.Worker|Runner\.Worker)\.exe"/i.test(r.stdout);
}

const agentWork: Category = {
  id: 'agent-work',
  group: 'dotnet',
  title: 'Stale build agent work folders',
  description: 'Azure DevOps _work\\<N> and GitHub runner _work\\<repo> folders untouched for --work-age days (default 30). The agent checks out again on the next run.',
  risk: 'moderate',
  async scan(ctx): Promise<ScanResult> {
    const res = emptyScan();
    const agents = await findAgents(ctx);
    const cutoff = Date.now() - ctx.options.workAgeDays * 86_400_000;
    for (const a of agents) {
      for (const e of await fsp.readdir(a.work, { withFileTypes: true }).catch(() => [])) {
        if (isAborted()) break;
        if (!e.isDirectory() || e.isSymbolicLink() || !isBuildDir(a.kind, e.name)) continue;
        const dir = path.join(a.work, e.name);
        progress.start(`agent-work: ${dir}`);
        const newest = await newestIn(dir);
        progress.done();
        if (newest > cutoff) continue;
        const m = await measure(dir);
        const item: Item = { path: dir, root: a.work, bytes: m.bytes, files: m.files, action: 'tree', detail: `${a.kind}, last used ${newest ? fmtDate(newest) : '?'}` };
        res.items.push(item);
        res.bytes += m.bytes;
        res.files += m.files;
      }
    }
    res.items.sort((a, b) => b.bytes - a.bytes);
    res.notes.push(agents.length ? `agents: ${agents.map((a) => a.root).join(', ')}` : 'no build agents found (add them to agentRoots in the config)');
    return res;
  },
  async clean(ctx, scan) {
    const res = emptyClean();
    if (!ctx.dryRun && (await workerRunning())) return { ...res, notes: ['a build job is running (Agent.Worker / Runner.Worker) — skipped, try again later'] };
    for (const item of scan.items) {
      if (isAborted()) break;
      if (!item.root || !isSafeTarget(item.path, item.root)) {
        ctx.log.warn(`refused (outside root or protected): ${item.path}`);
        continue;
      }
      if (ctx.dryRun) ctx.log.debug(`[dry-run] ${item.path} (${fmtBytes(item.bytes)})`);
      else if (await deleteTree(item.path)) ctx.log.debug(`deleted ${item.path} (${fmtBytes(item.bytes)})`);
      else {
        res.failed++;
        continue;
      }
      res.deleted++;
      res.freedBytes += item.bytes;
    }
    if (res.failed) res.notes.push(`${res.failed} folders could not be fully removed`);
    return res;
  },
};

export function dotnetCategories(): Category[] {
  return [nugetCache, dotnetSdks, agentDiag, agentWork];
}

export function resetDotnetCaches() {
  agentsCache = undefined;
}
