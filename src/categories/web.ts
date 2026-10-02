import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { asArray, fixedDrives, isWindows, powershellJson } from '../lib/sys';
import { existingRoots } from './fileset';
import { logSet, type LogFiles } from './logset';
import type { Category, Ctx } from './types';

export interface NginxConf {
  includes: string[];
  /** access_log / error_log targets (as written: relative or absolute). */
  logs: string[];
  /** A log path uses a variable — its folder is listed instead. */
  variableLogs: string[];
}

/** Pull `include`, `access_log` and `error_log` out of an nginx config (comments stripped, quotes removed). */
export function parseNginxConf(text: string): NginxConf {
  const clean = text.replace(/#[^\n]*/g, '');
  const res: NginxConf = { includes: [], logs: [], variableLogs: [] };
  const unq = (s: string) => s.replace(/^["']|["']$/g, '');
  for (const m of clean.matchAll(/(?:^|[;{}\s])include\s+([^;]+);/g)) res.includes.push(unq(m[1]!.trim()));
  for (const m of clean.matchAll(/(?:^|[;{}\s])(access_log|error_log)\s+([^\s;]+)[^;]*;/g)) {
    const target = unq(m[2]!);
    if (/^(off|stderr|\/dev\/null|nul)$/i.test(target) || /^(syslog|memory):/i.test(target)) continue;
    if (target.includes('$')) res.variableLogs.push(target);
    else res.logs.push(target);
  }
  return res;
}

/** Expand a simple `*` / `?` glob in the last path segment (what nginx `include` usually uses). */
async function expandGlob(p: string): Promise<string[]> {
  const base = path.basename(p);
  if (!/[*?]/.test(base)) return existsSync(p) ? [p] : [];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const dir = path.dirname(p);
  return (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).map((n) => path.join(dir, n));
}

/** All log files and log folders of one nginx install. */
export async function nginxLogs(prefix: string, confFile = path.join(prefix, 'conf', 'nginx.conf')): Promise<{ active: string[]; dirs: string[]; variable: string[] }> {
  const active = new Set<string>();
  const dirs = new Set<string>([path.join(prefix, 'logs')]);
  const variable: string[] = [];
  const seen = new Set<string>();
  const confDir = path.dirname(confFile);
  // nginx resolves log paths against the prefix and includes against the conf folder.
  const abs = (p: string, base: string) => path.normalize(path.isAbsolute(p) || /^[a-z]:/i.test(p) ? p : path.join(base, p));

  const visit = async (file: string, depth: number) => {
    const key = file.toLowerCase();
    if (seen.has(key) || depth > 8) return;
    seen.add(key);
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const conf = parseNginxConf(text);
    for (const l of conf.logs) active.add(abs(l, prefix));
    for (const v of conf.variableLogs) {
      variable.push(v);
      const fixed = v.slice(0, v.indexOf('$'));
      const dir = fixed.endsWith('/') || fixed.endsWith('\\') ? fixed : path.dirname(fixed);
      if (dir && dir !== '.') dirs.add(abs(dir, prefix));
    }
    for (const inc of conf.includes) for (const f of await expandGlob(abs(inc, confDir))) await visit(f, depth + 1);
  };
  await visit(confFile, 0);
  // Defaults when the config doesn't say otherwise.
  if (![...active].some((f) => /access/i.test(path.basename(f)))) active.add(path.join(prefix, 'logs', 'access.log'));
  if (![...active].some((f) => /error/i.test(path.basename(f)))) active.add(path.join(prefix, 'logs', 'error.log'));
  for (const f of active) dirs.add(path.dirname(f));
  return { active: [...active], dirs: [...dirs], variable };
}

interface ProcInfo {
  ExecutablePath?: string;
  CommandLine?: string;
}

const NGINX_PS = `
$o = @()
Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $o += [pscustomobject]@{ ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine } }
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -match 'nginx' -or $_.Name -match 'nginx' } | ForEach-Object {
  $p = $_.PathName
  $app = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$($_.Name)\\Parameters" -ErrorAction SilentlyContinue).Application
  if ($app) { $p = $app }
  $o += [pscustomobject]@{ ExecutablePath = $p; CommandLine = $p }
}
@($o) | ConvertTo-Json -Compress
`;

/** nginx installs: running processes, services (incl. nssm wrappers), X:\\nginx* folders, and the config. */
export async function nginxPrefixes(ctx: Ctx): Promise<Array<{ prefix: string; conf?: string }>> {
  const found = new Map<string, { prefix: string; conf?: string }>();
  const add = (prefix: string, conf?: string) => {
    const key = path.resolve(prefix).toLowerCase();
    if (!found.has(key) || conf) found.set(key, { prefix: path.resolve(prefix), conf });
  };
  for (const r of ctx.options.nginxRoots) if (existsSync(r)) add(r);
  if (isWindows) {
    for (const p of asArray(await powershellJson<ProcInfo | ProcInfo[]>(NGINX_PS, 60_000))) {
      const exe = (p.ExecutablePath ?? '').replace(/^"([^"]+)".*$/, '$1').replace(/\s+-.*$/, '').trim();
      if (!/nginx\.exe$/i.test(exe)) continue;
      const cmd = p.CommandLine ?? '';
      const prefix = /\s-p\s+"?([^"\s]+)"?/.exec(cmd)?.[1];
      const conf = /\s-c\s+"?([^"\s]+)"?/.exec(cmd)?.[1];
      const pre = prefix ? path.resolve(path.dirname(exe), prefix) : path.dirname(exe);
      add(pre, conf ? path.resolve(pre, conf) : undefined);
    }
    for (const d of await fixedDrives()) {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && /^nginx/i.test(e.name) && existsSync(path.join(d, e.name, 'nginx.exe'))) add(path.join(d, e.name));
      }
      for (const tools of ['tools', 'Tools']) {
        for (const e of await fsp.readdir(path.join(d, tools), { withFileTypes: true }).catch(() => [])) {
          if (e.isDirectory() && /^nginx/i.test(e.name) && existsSync(path.join(d, tools, e.name, 'nginx.exe'))) add(path.join(d, tools, e.name));
        }
      }
    }
  }
  return [...found.values()];
}

async function findNginxLogs(ctx: Ctx): Promise<LogFiles> {
  const out: LogFiles = { active: [], dirs: [], notes: [] };
  const prefixes = await nginxPrefixes(ctx);
  if (!prefixes.length) {
    out.notes.push('no nginx found (add its folder to nginxRoots in the config)');
    return out;
  }
  for (const p of prefixes) {
    const l = await nginxLogs(p.prefix, p.conf);
    out.active.push(...l.active);
    out.dirs.push(...(await existingRoots(l.dirs)));
    if (l.variable.length) out.notes.push(`${p.prefix}: logs with variables (${l.variable.slice(0, 2).join(', ')}) — their folders are treated as rotated logs`);
  }
  out.notes.push(`nginx: ${prefixes.map((p) => p.prefix).join(', ')}`);
  out.notes.push('nginx on Windows never rotates logs — schedule `disk-janitor clean --only nginx-logs --yes` weekly');
  return out;
}

export function webCategories(): Category[] {
  return [
    logSet({
      id: 'nginx-logs',
      group: 'web',
      title: 'nginx logs',
      description: 'access/error logs of every nginx found (running processes, services, X:\\nginx*, nginxRoots; paths from nginx.conf and its includes). Active logs are trimmed in place.',
      risk: 'safe',
      find: findNginxLogs,
    }),
  ];
}
