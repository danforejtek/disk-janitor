import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../categories';
import { attributeFolders, findOrphans, installedApps, installerPackages, msiReferences, type AppFolder } from '../lib/apps';
import { buildIndex, findNode, type DirNode, type DriveIndex } from '../lib/driveindex';
import { c, fmtBytes, fmtDate, fmtNum, table } from '../lib/format';
import { isInside } from '../lib/fsops';
import { progress } from '../lib/progress';
import { measure } from '../lib/walk';
import { driveSpace, fileSize, ntfsInfo, run, selfCommand, shadowStorage, userProfiles, winPaths } from '../lib/sys';

export interface Bucket {
  label: string;
  path?: string;
  bytes: number;
  files?: number;
  hint?: string;
  children?: Bucket[];
}

export interface AppsReport {
  /** Programs shown in Settings › Installed apps (not hidden). */
  visibleApps: number;
  /** Sum of their EstimatedSize — what the rows add up to. */
  registryBytes: number;
  appsWithoutSize: number;
  /** Measured size of program folders + installer caches. */
  measuredBytes: number;
  folders: Array<Omit<AppFolder, 'apps'> & { apps: Array<{ name: string; estimatedBytes?: number }> }>;
  leftoverBytes: number;
  caches: Bucket[];
  notes: string[];
}

export interface ExplainResult {
  host?: string;
  time: string;
  drive: string;
  admin: boolean;
  total: number;
  used: number;
  free: number;
  /** Logical size of everything the walk could read (hard links once). */
  walked: number;
  /** Walked files rounded up to clusters — what they really occupy. */
  allocated: number;
  files: number;
  dirs: number;
  hardLinkSaved: number;
  buckets: Bucket[];
  hidden: Bucket[];
  /** used − allocated − hidden. Negative when compression/dedup make files smaller on disk than their size. */
  unaccounted: number;
  unreadable: { count: number; samples: string[] };
  largestFiles: Array<{ path: string; bytes: number; mtime: number }>;
  apps?: AppsReport;
  notes: string[];
  ms: number;
}

const HIDDEN_FILES = ['pagefile.sys', 'swapfile.sys', 'hiberfil.sys'];
const FILES_LABEL = '(files in this folder)';

/** Children of a node as buckets: the `top` largest, the rest folded into "other". */
function childBuckets(n: DirNode, top: number, hints: Record<string, string> = {}): Bucket[] {
  const kids = [...n.children.values()].filter((k) => k.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const out: Bucket[] = kids.slice(0, top).map((k) => ({
    label: k.name,
    path: k.path,
    bytes: k.bytes,
    files: k.files,
    hint: hints[k.name.toLowerCase()],
  }));
  const rest = kids.slice(top).reduce((s, k) => s + k.bytes, 0) + n.ownBytes;
  if (rest > 0) out.push({ label: kids.length > top ? `other (${kids.length - top} folders + files)` : FILES_LABEL, bytes: rest });
  return out;
}

const WINDOWS_HINTS: Record<string, string> = {
  winsxs: 'component store — clean with `component-store` (DISM), never by hand',
  installer: 'MSI/MSP cache needed for repair/uninstall — see `msi-orphans` / `installer-patchcache`',
  softwaredistribution: 'Windows Update cache — `wu-cache`',
  logs: 'servicing logs — `win-logs`',
  temp: 'temp files — `temp`',
  livekernelreports: 'kernel dumps — `crash-dumps`',
  memory: 'crash dump',
  'system32': 'incl. winevt\\Logs (event logs) and spool',
};

const PROFILE_HINTS: Record<string, string> = {
  '.cache': 'Puppeteer/other tool caches — `browser-cache`',
  '.nuget': 'NuGet packages — `nuget-cache`',
  '.pm2': 'pm2 logs — `pm2-logs`',
};

async function appsReport(ctx: Ctx, idx: DriveIndex): Promise<AppsReport> {
  const w = winPaths();
  const apps = await installedApps();
  const visible = apps.filter((a) => !a.hidden);
  const notes: string[] = [];

  // Folders Settings counts under "Installed apps": Program Files (both), ProgramData, per-user Programs.
  const folders: Array<{ path: string; bytes: number; files?: number; newest?: number }> = [];
  for (const root of [w.programFiles, w.programFilesX86, w.programData]) {
    const n = findNode(idx, root);
    if (!n) continue;
    for (const k of n.children.values()) folders.push({ path: k.path, bytes: k.bytes, files: k.files, newest: k.newest });
  }
  for (const p of await userProfiles()) {
    const programs = path.join(p, 'AppData', 'Local', 'Programs');
    if (!isInside(programs, idx.root) || !existsSync(programs)) continue;
    for (const e of await fsp.readdir(programs, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const m = await measure(path.join(programs, e.name));
      folders.push({ path: path.join(programs, e.name), bytes: m.bytes, files: m.files });
    }
  }
  const attributed = attributeFolders(
    folders.filter((f) => f.bytes > 0),
    apps,
  ).sort((a, b) => b.bytes - a.bytes);

  // Installer caches: real disk use that no app row in Settings ever shows.
  const caches: Bucket[] = [];
  const installer = path.join(w.systemRoot, 'Installer');
  const instNode = findNode(idx, installer);
  if (instNode) {
    let hint = 'packages Windows Installer keeps for repair/uninstall';
    try {
      const refs = await msiReferences();
      const pkgs = await installerPackages(installer);
      const orphans = findOrphans(pkgs, refs.refs);
      const ob = orphans.reduce((s, o) => s + o.bytes, 0);
      hint = `${fmtNum(orphans.length)} of ${fmtNum(pkgs.length)} packages orphaned (${fmtBytes(ob)}) — see \`msi-orphans\``;
    } catch (e) {
      hint += ` (orphan check skipped: ${(e as Error).message})`;
    }
    caches.push({ label: 'Windows\\Installer', path: installer, bytes: instNode.bytes, files: instNode.files, hint });
    const patch = instNode.children.get('$patchcache$');
    if (patch?.bytes) caches.push({ label: 'Windows\\Installer\\$PatchCache$', path: patch.path, bytes: patch.bytes, hint: 'baseline copies for patch uninstall — `installer-patchcache`' });
  }
  const pkgCache = findNode(idx, path.join(w.programData, 'Package Cache'));
  if (pkgCache?.bytes)
    caches.push({ label: 'ProgramData\\Package Cache', path: pkgCache.path, bytes: pkgCache.bytes, hint: 'Visual Studio / .NET / SQL bundle installers — needed to modify or uninstall them' });
  const winApps = findNode(idx, path.join(w.programFiles, 'WindowsApps'));
  if (winApps?.unreadable) notes.push('Program Files\\WindowsApps is not readable even elevated — Store app sizes are only in Settings');

  const measuredBytes = attributed.reduce((s, f) => s + f.bytes, 0) + (instNode?.bytes ?? 0);
  const registryBytes = visible.reduce((s, a) => s + (a.estimatedBytes ?? 0), 0);
  const leftovers = attributed.filter((f) => f.match === 'none');
  if (!apps.length) notes.push('could not read the Uninstall registry keys');
  notes.push(
    'Settings sums these folders for the "Installed apps" total, but each app row shows only the size the installer wrote to the registry (often missing or stale).',
  );
  if (leftovers.length) notes.push('folders matching no installed program are often leftovers of uninstalled software — check before deleting by hand');
  return {
    visibleApps: visible.length,
    registryBytes,
    appsWithoutSize: visible.filter((a) => !a.estimatedBytes).length,
    measuredBytes,
    folders: attributed.map((f) => ({ ...f, apps: f.apps.slice(0, 3).map((a) => ({ name: a.name, estimatedBytes: a.estimatedBytes })) })),
    leftoverBytes: leftovers.reduce((s, f) => s + f.bytes, 0),
    caches,
    notes,
  };
}

/** Split a drive's used space into named buckets, hidden system areas and what nothing can see. */
export async function runExplain(ctx: Ctx, driveArg: string): Promise<{ result: ExplainResult; index: DriveIndex }> {
  const t0 = Date.now();
  const letter = /^([a-z]):?\\?$/i.exec(driveArg.trim())?.[1];
  const drive = letter ? `${letter.toUpperCase()}:\\` : path.resolve(driveArg);
  const w = winPaths();
  const isSystem = drive.toUpperCase().startsWith(w.systemDrive.toUpperCase());
  const space = await driveSpace(drive);
  if (!space) throw new Error(`cannot read drive ${drive}`);

  const idx = await buildIndex(drive, { maxDepth: 4, topFiles: 200, expectedBytes: space.total - space.free });
  const root = idx.tree;
  const notes: string[] = [];
  progress.start('checking page file, shadow copies and the NTFS file table');

  // Hidden: system files the walker cannot stat, shadow copies, NTFS metadata.
  const hidden: Bucket[] = [];
  let rootHiddenCounted = 0;
  const unstatable = new Set(idx.unstatable.map((p) => p.toLowerCase()));
  for (const name of HIDDEN_FILES) {
    const p = path.join(drive, name);
    const size = await fileSize(p);
    if (!size) continue;
    hidden.push({ label: name, path: p, bytes: size, hint: name === 'hiberfil.sys' ? 'useless on a server — `hiberfil` runs powercfg /h off' : 'resize in System Properties › Advanced › Performance' });
    if (!unstatable.has(p.toLowerCase())) rootHiddenCounted += size; // walk already counted it in root files
  }
  const svi = root.children.get('system volume information');
  const sviReadable = svi && !svi.unreadable;
  const vss = (await shadowStorage()).items.find((v) => drive.toUpperCase().startsWith(v.volume));
  if (vss?.used && !sviReadable)
    hidden.push({ label: 'Shadow copies (VSS)', bytes: vss.used, hint: `restore points / backup snapshots in System Volume Information, max ${vss.max}` });
  const ntfs = await ntfsInfo(drive);
  if (ntfs?.mftBytes) hidden.push({ label: 'NTFS metadata ($MFT)', bytes: ntfs.mftBytes, hint: 'one record per file ever created; shrinks only by reformatting' });
  else if (!ctx.admin) notes.push('MFT size needs an elevated prompt');

  // Buckets from the walk.
  const buckets: Bucket[] = [];
  const top = [...root.children.values()].filter((k) => k.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  for (const k of top) {
    const lower = k.path.toLowerCase();
    const b: Bucket = { label: k.name, path: k.path, bytes: k.bytes, files: k.files };
    if (isSystem && lower === w.systemRoot.toLowerCase()) {
      b.children = childBuckets(k, 10, WINDOWS_HINTS);
      if (idx.hardLinkSaved) b.hint = `hard links counted once — Explorer shows ${fmtBytes(idx.hardLinkSaved)} more`;
    } else if (isSystem && lower === w.usersDir.toLowerCase()) {
      b.children = [...k.children.values()]
        .filter((p) => p.bytes > 0)
        .sort((a, b2) => b2.bytes - a.bytes)
        .map((p) => {
          const kids = [...p.children.values()];
          const appData = p.children.get('appdata');
          const parts: Bucket[] = [];
          if (appData) for (const sub of appData.children.values()) if (sub.bytes) parts.push({ label: `AppData\\${sub.name}`, path: sub.path, bytes: sub.bytes });
          for (const sub of kids) if (sub !== appData && sub.bytes) parts.push({ label: sub.name, path: sub.path, bytes: sub.bytes, hint: PROFILE_HINTS[sub.name.toLowerCase()] });
          parts.sort((a, b2) => b2.bytes - a.bytes);
          return { label: p.name, path: p.path, bytes: p.bytes, children: parts.slice(0, 8) };
        });
    } else if (k.children.size) {
      b.children = childBuckets(k, 8);
    }
    if (k.name.toLowerCase() === '$recycle.bin') b.hint = 'deleted files of all users — `recycle-bin`';
    if (k === svi) b.hint = 'restore points, shadow copies, dedup chunk store';
    buckets.push(b);
  }
  const rootFiles = root.ownBytes - rootHiddenCounted;
  if (rootFiles > 0) buckets.push({ label: `(files in ${drive})`, path: drive, bytes: rootFiles });

  // Walked bytes rounded to clusters; the hidden files already counted by the walk are moved to "hidden".
  const allocated = idx.allocated - rootHiddenCounted;
  const hiddenTotal = hidden.reduce((s, h) => s + h.bytes, 0);
  const used = space.total - space.free;
  const unaccounted = used - allocated - hiddenTotal;

  if (idx.unreadableCount) notes.push(`${fmtNum(idx.unreadableCount)} folders could not be read — their size is part of "unaccounted"${ctx.admin ? ' (try --as-system)' : ' (run elevated)'}`);
  if (unaccounted < -used * 0.02)
    notes.push(`files take ${fmtBytes(-unaccounted)} less on disk than their size: NTFS compression, CompactOS or Data Deduplication`);
  if (idx.allocated - idx.total > 256 * 1024 ** 2)
    notes.push(`${fmtBytes(idx.allocated - idx.total)} is cluster slack: ${fmtNum(idx.files)} files each rounded up to ${fmtBytes(idx.clusterSize)} clusters`);

  progress.start(isSystem ? 'matching program folders to installed apps' : 'finishing up');
  const apps = isSystem ? await appsReport(ctx, idx) : undefined;
  progress.done();

  const result: ExplainResult = {
    host: process.env.COMPUTERNAME,
    time: new Date().toISOString(),
    drive,
    admin: ctx.admin,
    total: space.total,
    used,
    free: space.free,
    walked: idx.total,
    allocated,
    files: idx.files,
    dirs: idx.dirs,
    hardLinkSaved: idx.hardLinkSaved,
    buckets,
    hidden,
    unaccounted,
    unreadable: { count: idx.unreadableCount, samples: idx.unreadable.slice(0, 50) },
    largestFiles: idx.topFiles.slice(0, 50).map((f) => ({ path: f.path, bytes: f.bytes, mtime: f.mtime })),
    apps,
    notes,
    ms: Date.now() - t0,
  };
  return { result, index: idx };
}

const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 100) : 0}%`;

export function printExplain(ctx: Ctx, r: ExplainResult) {
  const L = (s = '') => ctx.log.info(s);
  L(`${c.bold(r.drive)}  ${fmtBytes(r.used)} used of ${fmtBytes(r.total)} (${fmtBytes(r.free)} free)  ${c.dim(`${fmtNum(r.files)} files, ${(r.ms / 1000).toFixed(0)} s`)}`);
  L();
  const hiddenTotal = r.hidden.reduce((s, h) => s + h.bytes, 0);
  L(
    table(
      [
        [c.bold('Where the used space is'), '', ''],
        ['Files and folders (on-disk size)', fmtBytes(r.allocated), pct(r.allocated, r.used)],
        ['System areas no scanner lists', fmtBytes(hiddenTotal), pct(hiddenTotal, r.used)],
        [r.unaccounted >= 0 ? c.yellow('Unaccounted') : 'Saved by compression/dedup', fmtBytes(Math.abs(r.unaccounted)), pct(Math.abs(r.unaccounted), r.used)],
      ],
      ['l', 'r', 'r'],
    ),
  );

  L(`\n${c.bold('Folders')}`);
  const rows: string[][] = [];
  for (const b of r.buckets.slice(0, 15)) {
    rows.push([fmtBytes(b.bytes), pct(b.bytes, r.used), c.cyan(b.label), b.hint ? c.dim(b.hint) : '']);
    for (const ch of b.children?.slice(0, 6) ?? []) rows.push([fmtBytes(ch.bytes), '', `  ${ch.label}`, ch.hint ? c.dim(ch.hint) : '']);
  }
  L(table(rows, ['r', 'r', 'l', 'l']));

  if (r.hidden.length) {
    L(`\n${c.bold('System areas no scanner lists')}`);
    L(table(r.hidden.map((h) => [fmtBytes(h.bytes), h.label, c.dim(h.hint ?? '')]), ['r', 'l', 'l']));
  }

  if (r.apps) {
    const a = r.apps;
    L(`\n${c.bold('Installed apps')} ${c.dim('— why Settings shows a big total but small rows')}`);
    L(
      table(
        [
          ['App rows in Settings (registry sizes)', fmtBytes(a.registryBytes), c.dim(`${a.visibleApps} apps, ${a.appsWithoutSize} without a size`)],
          ['Measured program folders + installer cache', fmtBytes(a.measuredBytes), ''],
          ['Folders that match no installed app', c.yellow(fmtBytes(a.leftoverBytes)), ''],
        ],
        ['l', 'r', 'l'],
      ),
    );
    if (a.caches.length) {
      L();
      L(table(a.caches.map((x) => [fmtBytes(x.bytes), x.label, c.dim(x.hint ?? '')]), ['r', 'l', 'l']));
    }
    L();
    const fr = a.folders.slice(0, 20).map((f) => [
      fmtBytes(f.bytes),
      f.path,
      f.match === 'none' ? c.yellow('no installed app') : f.match === 'system' ? c.dim('Windows / shared') : f.apps.map((x) => x.name).join(', ').slice(0, 60),
      f.apps[0]?.estimatedBytes !== undefined ? c.dim(`reg ${fmtBytes(f.apps[0].estimatedBytes)}`) : '',
    ]);
    L(table(fr, ['r', 'l', 'l', 'l']));
    for (const n of a.notes) L(c.dim(`  · ${n}`));
  }

  L(`\n${c.bold('Largest files')}`);
  L(table(r.largestFiles.slice(0, 10).map((f) => [fmtBytes(f.bytes), c.dim(fmtDate(f.mtime)), f.path]), ['r', 'l', 'l']));

  if (r.unreadable.count) {
    L(`\n${c.bold('Not readable')} ${c.dim(`(${fmtNum(r.unreadable.count)} folders)`)}`);
    for (const s of r.unreadable.samples.slice(0, 5)) L(c.dim(`  ${s}`));
  }
  for (const n of r.notes) L(c.dim(`· ${n}`));
}

/** Re-run `explain` as SYSTEM through a one-time scheduled task; SYSTEM can read folders closed even to admins. */
export async function explainAsSystem(ctx: Ctx, drive: string): Promise<ExplainResult> {
  if (!ctx.admin) throw new Error('--as-system needs an elevated prompt');
  const dir = path.join(winPaths().programData, 'disk-janitor');
  await fsp.mkdir(dir, { recursive: true });
  const id = `disk-janitor-explain-${Date.now()}`;
  const out = path.join(dir, `${id}.json`);
  const self = selfCommand();
  const tr = [self.exe, ...self.args, 'explain', drive, '--json', '--out', out].map((a) => `"${a}"`).join(' ');
  if (tr.length > 261) throw new Error('command line too long for a scheduled task — move the exe to a shorter path');
  const create = await run('schtasks.exe', ['/Create', '/TN', id, '/RU', 'SYSTEM', '/SC', 'ONCE', '/ST', '00:00', '/SD', '01/01/2099', '/TR', tr, '/RL', 'HIGHEST', '/F']);
  if (create.code !== 0) throw new Error(`schtasks /Create failed: ${create.stderr.trim() || create.stdout.trim()}`);
  try {
    const start = await run('schtasks.exe', ['/Run', '/TN', id]);
    if (start.code !== 0) throw new Error(`schtasks /Run failed: ${start.stderr.trim()}`);
    ctx.log.info(c.dim(`Running as SYSTEM via scheduled task ${id}…`));
    const deadline = Date.now() + 2 * 60 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!existsSync(out)) continue;
      try {
        const res = JSON.parse(await fsp.readFile(out, 'utf8')) as ExplainResult;
        await fsp.rm(out, { force: true });
        return res;
      } catch {
        /* still being written */
      }
    }
    throw new Error('timed out waiting for the SYSTEM run');
  } finally {
    await run('schtasks.exe', ['/Delete', '/TN', id, '/F']);
  }
}
