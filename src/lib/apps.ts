import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isInside, samePath } from './fsops';
import { asArray, isWindows, powershellJson } from './sys';

export interface InstalledApp {
  name: string;
  publisher?: string;
  version?: string;
  installLocation?: string;
  /** Registry EstimatedSize (what Settings › Installed apps shows per row), in bytes. */
  estimatedBytes?: number;
  /** Hidden from Settings (SystemComponent=1 or an update of another entry). */
  hidden: boolean;
  scope: 'machine' | 'user';
}

interface RawApp {
  DisplayName?: string;
  Publisher?: string;
  DisplayVersion?: string;
  InstallLocation?: string;
  EstimatedSize?: number;
  SystemComponent?: number;
  ParentKeyName?: string;
  PSPath?: string;
}

const APPS_PS = `
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'Registry::HKEY_USERS\\*\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
@(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } |
  Select-Object DisplayName, Publisher, DisplayVersion, InstallLocation, EstimatedSize, SystemComponent, ParentKeyName, PSPath) |
  ConvertTo-Json -Compress -Depth 2
`;

let appsCache: InstalledApp[] | undefined;
/** Programs registered in the Uninstall keys (machine-wide, 32/64-bit, and every loaded user hive). */
export async function installedApps(): Promise<InstalledApp[]> {
  if (appsCache) return appsCache;
  if (!isWindows) return (appsCache = []);
  const raw = asArray(await powershellJson<RawApp | RawApp[]>(APPS_PS, 120_000));
  return (appsCache = raw
    .filter((a) => a.DisplayName)
    .map((a) => ({
      name: a.DisplayName!.trim(),
      publisher: a.Publisher?.trim() || undefined,
      version: a.DisplayVersion?.trim() || undefined,
      installLocation: a.InstallLocation?.trim().replace(/^"|"$/g, '') || undefined,
      estimatedBytes: typeof a.EstimatedSize === 'number' && a.EstimatedSize > 0 ? a.EstimatedSize * 1024 : undefined,
      hidden: a.SystemComponent === 1 || !!a.ParentKeyName,
      scope: /HKEY_USERS/i.test(a.PSPath ?? '') ? 'user' : 'machine',
    })));
}

/** Folders that belong to Windows itself, not to an installed program. */
const SYSTEM_FOLDERS = new Set(
  [
    'common files', 'windows defender', 'windows defender advanced threat protection', 'windows nt', 'windowspowershell',
    'windows mail', 'windows media player', 'windows photo viewer', 'windows sidebar', 'windows security', 'windows portable devices',
    'internet explorer', 'modifiablewindowsapps', 'windowsapps', 'reference assemblies', 'msbuild', 'uninstall information',
    'microsoft.net', 'microsoft update health tools', 'microsoft', 'package cache', 'packages', 'ssh', 'usoshared', 'usoprivate',
    'softwaredistribution', 'comms', 'windowsholographicdevices', 'regid.1991-06.com.microsoft', 'desktop.ini', 'device stage',
    'microsoft onedrive', 'dotnet', 'windows', 'templates', 'start menu', 'documents', 'application data', 'desktop',
    'nvidia corporation', 'intel', 'amd', 'oem', 'ntuser', 'temp', 'system32',
  ].map((s) => s.toLowerCase()),
);

const STOP_WORDS = /\b(inc|corp|corporation|ltd|llc|gmbh|ag|co|company|software|technologies|the|x64|x86|64-bit|32-bit)\b/g;
/** Lower-case letters and digits only, minus vendor suffixes. */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(STOP_WORDS, ' ')
    .replace(/[^a-z0-9]+/g, '');

export interface AppFolder {
  path: string;
  bytes: number;
  files?: number;
  newest?: number;
  /** Registered programs this folder belongs to. */
  apps: InstalledApp[];
  match: 'location' | 'name' | 'system' | 'none';
}

/**
 * Attribute folders (e.g. children of Program Files / ProgramData) to registered programs:
 * 1. a program's InstallLocation is the folder, inside it, or contains it;
 * 2. the folder name matches a program's DisplayName or Publisher;
 * 3. well-known Windows folders are labelled "system".
 * Anything else is a candidate leftover of an uninstalled program.
 */
export function attributeFolders(folders: Array<{ path: string; bytes: number; files?: number; newest?: number }>, apps: InstalledApp[]): AppFolder[] {
  const located = apps.filter((a) => a.installLocation && path.isAbsolute(a.installLocation));
  const named = apps.map((a) => ({
    app: a,
    name: normName(a.name),
    words: new Set(a.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
    pub: a.publisher ? normName(a.publisher) : '',
  }));
  // Short folder names ("Git", "7-Zip") must match a whole word or the start of the name, not any substring.
  const nameMatches = (x: (typeof named)[number], n: string) =>
    n.length < 5 ? x.words.has(n) || x.name.startsWith(n) : x.name.includes(n) || (x.name.length >= 5 && n.includes(x.name));
  return folders.map((f) => {
    const byLoc = located.filter(
      (a) => samePath(a.installLocation!, f.path) || isInside(a.installLocation!, f.path) || isInside(f.path, a.installLocation!),
    );
    if (byLoc.length) return { ...f, apps: byLoc, match: 'location' as const };
    const base = path.basename(f.path);
    const n = normName(base);
    if (n.length >= 3) {
      const byName = named
        .filter((x) => (x.name && nameMatches(x, n)) || (x.pub.length >= 4 && (x.pub === n || x.pub.startsWith(n) || n.startsWith(x.pub))))
        .map((x) => x.app);
      if (byName.length) return { ...f, apps: byName, match: 'name' as const };
    }
    if (SYSTEM_FOLDERS.has(base.toLowerCase()) || base.startsWith('{') || base.startsWith('regid.')) return { ...f, apps: [], match: 'system' as const };
    return { ...f, apps: [], match: 'none' as const };
  });
}

export interface MsiRefs {
  /** LocalPackage paths of every installed product and patch. */
  refs: Set<string>;
  fromCom: number;
  fromRegistry: number;
}

const MSI_PS = `
$refs = New-Object System.Collections.Generic.List[string]
$com = 0; $reg = 0
try {
  $i = New-Object -ComObject WindowsInstaller.Installer
  foreach ($p in $i.ProductsEx('', '', 7)) { try { $lp = $p.InstallProperty('LocalPackage'); if ($lp) { $refs.Add($lp); $com++ } } catch {} }
  foreach ($p in $i.PatchesEx('', '', 7, 15)) { try { $lp = $p.PatchProperty('LocalPackage'); if ($lp) { $refs.Add($lp); $com++ } } catch {} }
} catch {}
Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData' -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem "$($_.PSPath)\\Products" -ErrorAction SilentlyContinue | ForEach-Object {
    $lp = (Get-ItemProperty "$($_.PSPath)\\InstallProperties" -ErrorAction SilentlyContinue).LocalPackage
    if ($lp) { $refs.Add($lp); $reg++ }
  }
  Get-ChildItem "$($_.PSPath)\\Patches" -ErrorAction SilentlyContinue | ForEach-Object {
    $lp = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).LocalPackage
    if ($lp) { $refs.Add($lp); $reg++ }
  }
}
@{ refs = @($refs); com = $com; reg = $reg } | ConvertTo-Json -Compress
`;

/**
 * Every .msi/.msp in Windows\\Installer that Windows Installer still references.
 * Union of the MSI COM API (what PatchCleaner uses) and the UserData registry — more references = fewer deletions.
 */
export async function msiReferences(): Promise<MsiRefs> {
  if (!isWindows) return { refs: new Set(), fromCom: 0, fromRegistry: 0 };
  const r = await powershellJson<{ refs?: string[] | string; com?: number; reg?: number }>(MSI_PS, 300_000);
  return {
    refs: new Set(asArray(r?.refs).map((p) => path.resolve(p).toLowerCase())),
    fromCom: r?.com ?? 0,
    fromRegistry: r?.reg ?? 0,
  };
}

/** Pure part of orphan detection: which of `files` are not referenced. Throws when the reference list is empty (never guess). */
export function findOrphans<T extends { path: string }>(files: T[], refs: Set<string>): T[] {
  if (refs.size === 0) throw new Error('Windows Installer returned no references — refusing to treat every package as orphaned');
  return files.filter((f) => /\.(msi|msp)$/i.test(f.path) && !refs.has(path.resolve(f.path).toLowerCase()));
}

/** The .msi/.msp files directly in Windows\Installer (sub-folders hold icons and $PatchCache$). */
export async function installerPackages(installerDir: string): Promise<Array<{ path: string; bytes: number; mtime: number }>> {
  const out: Array<{ path: string; bytes: number; mtime: number }> = [];
  let ents;
  try {
    ents = await fsp.readdir(installerDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isFile() || !/\.(msi|msp)$/i.test(e.name)) continue;
    const full = path.join(installerDir, e.name);
    try {
      const st = await fsp.stat(full);
      out.push({ path: full, bytes: st.size, mtime: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return out;
}
