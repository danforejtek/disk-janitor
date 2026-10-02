import { exec, execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseSize } from './format';

export const isWindows = process.platform === 'win32';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function toResult(err: Error | null, stdout: unknown, stderr: unknown): RunResult {
  const raw = (err as (Error & { code?: unknown }) | null)?.code;
  const code = err ? (typeof raw === 'number' ? raw : -1) : 0;
  return { code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err?.message ?? '') };
}

/** Run an .exe directly (no shell). Never rejects. */
export function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) =>
      resolve(toResult(err, out, errOut)),
    );
  });
}

/** Run a command line through cmd.exe — needed for .cmd shims such as pnpm.cmd. */
export function runShell(commandLine: string, timeoutMs = 600_000): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(commandLine, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) =>
      resolve(toResult(err, out, errOut)),
    );
  });
}

/** Run a PowerShell script (passed base64-encoded, so quoting never breaks). Output is UTF-8. */
export const powershell = (script: string, timeoutMs = 60_000) =>
  run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64'),
    ],
    timeoutMs,
  );

/** Run a PowerShell script that writes JSON (ConvertTo-Json); returns the parsed value or undefined. */
export async function powershellJson<T>(script: string, timeoutMs = 60_000): Promise<T | undefined> {
  const r = await powershell(script, timeoutMs);
  const out = r.stdout.trim();
  if (!out) return undefined;
  try {
    return JSON.parse(out) as T;
  } catch {
    return undefined;
  }
}

/** ConvertTo-Json turns a one-element array into an object. */
export const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function winPaths() {
  const e = process.env;
  const systemDrive = e.SystemDrive ?? 'C:';
  const systemRoot = e.SystemRoot ?? e.windir ?? `${systemDrive}\\Windows`;
  return {
    systemDrive,
    systemRoot,
    programData: e.ProgramData ?? `${systemDrive}\\ProgramData`,
    programFiles: e.ProgramFiles ?? `${systemDrive}\\Program Files`,
    programFilesX86: e['ProgramFiles(x86)'] ?? `${systemDrive}\\Program Files (x86)`,
    usersDir: `${systemDrive}\\Users`,
  };
}

let adminCache: boolean | undefined;
export async function isAdmin(): Promise<boolean> {
  if (adminCache !== undefined) return adminCache;
  if (!isWindows) return (adminCache = process.getuid?.() === 0);
  // `net session` only succeeds in an elevated process.
  return (adminCache = (await run('net', ['session'], 15_000)).code === 0);
}

let drivesCache: string[] | undefined;
/** Local fixed disks as "C:\\", "D:\\", … (network, removable and optical drives excluded). */
export async function fixedDrives(): Promise<string[]> {
  if (drivesCache) return drivesCache;
  if (!isWindows) return (drivesCache = []);
  const r = await powershell("(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID", 30_000);
  const found = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]:$/.test(s));
  drivesCache = found.length
    ? found.map((d) => `${d}\\`)
    : 'CDEFGHIJKLMNOPQRSTUVWXYZ'
        .split('')
        .map((l) => `${l}:\\`)
        .filter((d) => existsSync(d));
  return drivesCache;
}

let profilesCache: string[] | undefined;
/** All local user profiles, including service-account profiles (SYSTEM, LocalService, NetworkService). */
export async function userProfiles(): Promise<string[]> {
  if (profilesCache) return profilesCache;
  const { usersDir, systemRoot } = winPaths();
  const out: string[] = [];
  try {
    for (const e of await fsp.readdir(usersDir, { withFileTypes: true })) {
      // Junctions like "All Users" / "Default User" report as symlinks and are skipped.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (['public', 'default'].includes(e.name.toLowerCase())) continue;
      out.push(path.join(usersDir, e.name));
    }
  } catch {
    /* not readable / not Windows */
  }
  // Profiles on other drives (rare on servers) come from the registry.
  if (isWindows) {
    const r = await powershell(
      "Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special } | ForEach-Object { $_.LocalPath }",
      30_000,
    );
    for (const p of r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (!out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
    }
  }
  out.push(
    `${systemRoot}\\System32\\config\\systemprofile`,
    `${systemRoot}\\ServiceProfiles\\LocalService`,
    `${systemRoot}\\ServiceProfiles\\NetworkService`,
  );
  return (profilesCache = out);
}

/** Full path of a command on PATH, or undefined. */
export async function which(cmd: string): Promise<string | undefined> {
  const r = isWindows ? await run('where.exe', [cmd], 10_000) : await run('which', [cmd], 10_000);
  if (r.code !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // Prefer the .cmd shim on Windows (the extensionless file is a bash script).
  return lines.find((l) => /\.(cmd|exe)$/i.test(l)) ?? lines[0];
}

export async function serviceRunning(name: string): Promise<boolean> {
  const r = await run('sc.exe', ['query', name], 15_000);
  return /STATE\s*:\s*\d+\s+RUNNING/i.test(r.stdout);
}
export const stopService = (name: string) => run('net', ['stop', name, '/y'], 120_000);
export const startService = (name: string) => run('net', ['start', name], 120_000);

export interface DriveSpace {
  drive: string;
  total: number;
  free: number;
}
export async function driveSpace(drive: string): Promise<DriveSpace | undefined> {
  try {
    const s = await fsp.statfs(drive);
    return { drive, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return undefined;
  }
}

/** Size of a single file, falling back to PowerShell for locked system files (pagefile, hiberfil). */
export async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || !isWindows) return undefined;
    // Get-Item can't open pagefile/hiberfil either; a directory listing still reports their size.
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const r = await powershell(`(Get-ChildItem -LiteralPath ${q(path.dirname(file))} -Force -Filter ${q(path.basename(file))} -ErrorAction Stop).Length`);
    const n = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(n) ? n : undefined;
  }
}

export interface ShadowStorage {
  volume: string;
  used: number;
  max: string;
}
/** `vssadmin list shadowstorage`: space used by shadow copies per volume (needs elevation). */
export async function shadowStorage(): Promise<{ items: ShadowStorage[]; ok: boolean }> {
  if (!isWindows) return { items: [], ok: false };
  const r = await run('vssadmin.exe', ['list', 'shadowstorage'], 60_000);
  const items: ShadowStorage[] = [];
  for (const block of r.stdout.split(/Shadow Copy Storage association/i).slice(1)) {
    const vol = /For volume:\s*\(([A-Z]:)\)/i.exec(block)?.[1] ?? '?';
    const used = /Used Shadow Copy Storage space:\s*([\d.,]+)\s*([KMGT]?B)/i.exec(block);
    const max = /Maximum Shadow Copy Storage space:\s*(UNBOUNDED|[\d.,]+\s*[KMGT]?B)/i.exec(block)?.[1];
    if (!used?.[1] || !used[2]) continue;
    items.push({ volume: vol.toUpperCase(), used: parseSize(used[1], used[2]), max: max ?? '?' });
  }
  // Exit code 2 with "No items found" is a success with nothing to report.
  return { items, ok: r.code === 0 || /no items found/i.test(r.stdout) };
}

/** NTFS metadata sizes from `fsutil fsinfo ntfsinfo` (needs elevation). */
export async function ntfsInfo(drive: string): Promise<{ mftBytes: number; clusterSize: number } | undefined> {
  if (!isWindows) return undefined;
  const r = await run('fsutil.exe', ['fsinfo', 'ntfsinfo', drive.replace(/\$/, '')], 30_000);
  if (r.code !== 0) return undefined;
  const num = (label: string) => {
    const m = new RegExp(`${label}\\s*:\\s*(0x[0-9a-f]+|[\\d.,\\s]+)`, 'i').exec(r.stdout)?.[1]?.trim();
    if (!m) return 0;
    return m.startsWith('0x') ? Number.parseInt(m, 16) : Number(m.replace(/[^\d]/g, ''));
  };
  return { mftBytes: num('Mft Valid Data Length'), clusterSize: num('Bytes Per Cluster') };
}

/** Lower-case image name of the process that started us ("explorer.exe" after a double-click). */
export async function parentProcessName(): Promise<string> {
  if (!isWindows) return '';
  const r = await run('tasklist.exe', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH'], 10_000);
  return /^"([^"]+)"/.exec(r.stdout.trim())?.[1]?.toLowerCase() ?? '';
}

/** Start this program again elevated (UAC prompt). False when the user said no. */
export async function relaunchElevated(args: string[]): Promise<boolean> {
  const self = selfCommand();
  const q = (s: string) => s.replace(/'/g, "''");
  // Start-Process joins arguments with spaces and doesn't quote them, so quote here.
  const argLine = [...self.args, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const r = await powershell(
    `try { Start-Process -FilePath '${q(self.exe)}' -ArgumentList '${q(argLine)}' -WorkingDirectory '${q(process.cwd())}' -Verb RunAs -ErrorAction Stop; 'ok' } catch { 'no' }`,
    120_000,
  );
  return r.stdout.trim().endsWith('ok');
}

/** Running as a Node single executable (the built .exe) rather than `node script.cjs`. */
export function selfCommand(): { exe: string; args: string[] } {
  let sea = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sea = (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    /* older Node */
  }
  return sea || !process.argv[1] ? { exe: process.execPath, args: [] } : { exe: process.execPath, args: [path.resolve(process.argv[1])] };
}
