import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { findOrphans, installerPackages, msiReferences } from '../lib/apps';
import { fmtBytes, fmtDate, parseSize } from '../lib/format';
import { deleteFile, deleteTree, isSafeTarget, moveFile } from '../lib/fsops';
import { progress } from '../lib/progress';
import { driveSpace, fileSize, fixedDrives, isWindows, run, shadowStorage, userProfiles, winPaths } from '../lib/sys';
import { measure } from '../lib/walk';
import { existingRoots, fileSet } from './fileset';
import { emptyClean, emptyScan, type Category, type ScanResult } from './types';

const perProfile = async (...rel: string[]) => (await userProfiles()).map((p) => path.join(p, ...rel));

export function systemCategories(): Category[] {
  const w = winPaths();

  const temp = fileSet({
    id: 'temp',
    group: 'system',
    title: 'Temp files',
    description: 'Windows\\Temp and every profile\'s AppData\\Local\\Temp (incl. SYSTEM and service accounts).',
    risk: 'safe',
    needsAdmin: true,
    roots: async () => [`${w.systemRoot}\\Temp`, ...(await perProfile('AppData', 'Local', 'Temp'))],
    minAgeDays: (ctx) => ctx.options.tempAgeDays,
  });

  const wuCache = fileSet({
    id: 'wu-cache',
    group: 'system',
    title: 'Windows Update download cache',
    description: 'SoftwareDistribution\\Download and the Delivery Optimization cache. Services are stopped while cleaning.',
    risk: 'safe',
    needsAdmin: true,
    roots: () => [
      `${w.systemRoot}\\SoftwareDistribution\\Download`,
      `${w.systemRoot}\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache`,
    ],
    minAgeDays: () => 0,
    services: ['wuauserv', 'bits', 'dosvc'],
  });

  const winLogs = fileSet({
    id: 'win-logs',
    group: 'system',
    title: 'CBS / DISM / servicing logs',
    description: 'Old *.log, *.cab and *.etl in Windows\\Logs (the active CBS.log and dism.log are kept).',
    risk: 'safe',
    needsAdmin: true,
    roots: () => [`${w.systemRoot}\\Logs\\CBS`, `${w.systemRoot}\\Logs\\DISM`, `${w.systemRoot}\\Logs\\WindowsUpdate`, `${w.systemRoot}\\Logs\\MoSetup`],
    match: (n) => /\.(log|cab|etl)$/i.test(n) && !['cbs.log', 'dism.log'].includes(n.toLowerCase()),
    minAgeDays: (ctx) => ctx.options.logAgeDays,
  });

  const crashDumps = fileSet({
    id: 'crash-dumps',
    group: 'system',
    title: 'Crash dumps',
    description: 'MEMORY.DMP, Minidump, LiveKernelReports and per-user CrashDumps. Keep them if a crash is still being investigated.',
    risk: 'moderate',
    needsAdmin: true,
    roots: async () => [
      `${w.systemRoot}\\MEMORY.DMP`,
      `${w.systemRoot}\\Minidump`,
      `${w.systemRoot}\\LiveKernelReports`,
      ...(await perProfile('AppData', 'Local', 'CrashDumps')),
    ],
    minAgeDays: () => 0,
  });

  const wer = fileSet({
    id: 'wer',
    group: 'system',
    title: 'Windows Error Reporting',
    description: 'Queued and archived WER reports (system-wide and per profile).',
    risk: 'safe',
    needsAdmin: true,
    roots: async () => [
      `${w.programData}\\Microsoft\\Windows\\WER\\ReportArchive`,
      `${w.programData}\\Microsoft\\Windows\\WER\\ReportQueue`,
      `${w.programData}\\Microsoft\\Windows\\WER\\Temp`,
      ...(await perProfile('AppData', 'Local', 'Microsoft', 'Windows', 'WER')),
    ],
    minAgeDays: () => 0,
  });

  const recycleBin: Category = {
    id: 'recycle-bin',
    group: 'system',
    title: 'Recycle Bin (all users, all drives)',
    description: 'Contents of X:\\$Recycle.Bin on every fixed drive.',
    risk: 'moderate',
    needsAdmin: true,
    async scan() {
      const res = emptyScan();
      const bins = await existingRoots((await fixedDrives()).map((d) => `${d}$Recycle.Bin`));
      for (const bin of bins) {
        progress.start(`recycle-bin: ${bin}`);
        const m = await measure(bin, { filter: (f) => path.basename(f).toLowerCase() !== 'desktop.ini' });
        progress.done();
        res.errors += m.walk.errors;
        if (m.files) res.items.push({ path: bin, bytes: m.bytes, files: m.files });
        res.bytes += m.bytes;
        res.files += m.files;
      }
      return res;
    },
    async clean(ctx, scan) {
      const res = emptyClean();
      for (const item of scan.items) {
        // $Recycle.Bin\<SID>\{$I…,$R…}
        for (const sid of await fsp.readdir(item.path).catch(() => [] as string[])) {
          const sidDir = path.join(item.path, sid);
          for (const entry of await fsp.readdir(sidDir).catch(() => [] as string[])) {
            if (entry.toLowerCase() === 'desktop.ini') continue;
            const target = path.join(sidDir, entry);
            if (!isSafeTarget(target, item.path)) continue;
            if (ctx.dryRun || (await deleteTree(target))) {
              res.deleted++;
              ctx.log.debug(`${ctx.dryRun ? '[dry-run] ' : 'deleted '}${target}`);
            } else res.failed++;
          }
        }
        res.freedBytes += item.bytes;
      }
      if (res.failed) res.notes.push(`${res.failed} entries could not be removed`);
      return res;
    },
  };

  const hiberfil: Category = {
    id: 'hiberfil',
    group: 'system',
    title: 'Hibernation file',
    description: 'hiberfil.sys — useless on a server. Cleaning runs `powercfg /h off`.',
    risk: 'safe',
    needsAdmin: true,
    async scan() {
      const file = `${w.systemDrive}\\hiberfil.sys`;
      const size = await fileSize(file);
      if (!size) return emptyScan();
      return { bytes: size, files: 1, items: [{ path: file, bytes: size }], notes: [], errors: 0 };
    },
    async clean(ctx, scan) {
      const res = emptyClean();
      if (ctx.dryRun) return { ...res, freedBytes: scan.bytes, deleted: 1 };
      const r = await run('powercfg.exe', ['/h', 'off']);
      if (r.code === 0) return { ...res, freedBytes: scan.bytes, deleted: 1 };
      return { ...res, failed: 1, notes: [`powercfg failed: ${r.stderr.trim() || r.stdout.trim()}`] };
    },
  };

  const pagefile: Category = {
    id: 'pagefile',
    group: 'system',
    title: 'Page / swap files',
    description: 'pagefile.sys and swapfile.sys on every drive. Never delete — resize in System Properties › Performance › Virtual memory.',
    risk: 'caution',
    reportOnly: true,
    async scan() {
      const res = emptyScan();
      for (const d of await fixedDrives()) {
        for (const name of ['pagefile.sys', 'swapfile.sys']) {
          const size = await fileSize(`${d}${name}`);
          if (size) res.items.push({ path: `${d}${name}`, bytes: size });
        }
      }
      res.bytes = res.items.reduce((s, i) => s + i.bytes, 0);
      res.files = res.items.length;
      return res;
    },
  };

  const shadow: Category = {
    id: 'shadow-storage',
    group: 'system',
    title: 'Volume Shadow Copies',
    description: 'Space used by restore points / shadow copies (lives in "System Volume Information", invisible to scanners).',
    risk: 'caution',
    reportOnly: true,
    needsAdmin: true,
    async scan(): Promise<ScanResult> {
      if (!isWindows) return emptyScan();
      const { items, ok } = await shadowStorage();
      const res = emptyScan();
      for (const i of items) {
        res.items.push({ path: i.volume, bytes: i.used, detail: `max: ${i.max}` });
        res.bytes += i.used;
      }
      if (res.items.length)
        res.notes.push('to cap it: vssadmin resize shadowstorage /for=C: /on=C: /maxsize=10GB (check your backup tool first)');
      else if (!ok) res.notes.push('vssadmin failed — run elevated');
      return res;
    },
  };

  const componentStore: Category = {
    id: 'component-store',
    group: 'system',
    title: 'WinSxS component store',
    description: 'Superseded update components. Uses DISM (/AnalyzeComponentStore, /StartComponentCleanup). Takes minutes.',
    risk: 'safe',
    needsAdmin: true,
    deepOnly: true,
    async scan(): Promise<ScanResult> {
      if (!isWindows) return emptyScan();
      progress.start('component-store: DISM /AnalyzeComponentStore (this takes a few minutes)');
      const r = await run('dism.exe', ['/Online', '/Cleanup-Image', '/AnalyzeComponentStore', '/English'], 30 * 60_000);
      progress.done();
      const grab = (label: string) => {
        const m = new RegExp(`${label}\\s*:\\s*([\\d.,]+)\\s*([KMGT]?B)`, 'i').exec(r.stdout);
        return m?.[1] && m[2] ? parseSize(m[1], m[2]) : 0;
      };
      const actual = grab('Actual Size of Component Store');
      const backups = grab('Backups and Disabled Features');
      const cache = grab('Cache and Temporary Data');
      const recommended = /Cleanup Recommended\s*:\s*Yes/i.test(r.stdout);
      if (!actual) return emptyScan([`DISM failed (exit ${r.code}) — run elevated`]);
      const estimate = recommended ? backups + cache : cache;
      return {
        bytes: estimate,
        files: 0,
        items: [{ path: `${w.systemRoot}\\WinSxS`, bytes: estimate, detail: `actual size ${fmtBytes(actual)}, cleanup recommended: ${recommended ? 'yes' : 'no'}` }],
        notes: ['estimate is an upper bound; --reset-base frees more but makes installed updates permanent'],
        errors: 0,
      };
    },
    async clean(ctx) {
      const res = emptyClean();
      const args = ['/Online', '/Cleanup-Image', '/StartComponentCleanup', '/English'];
      if (ctx.options.resetBase) args.push('/ResetBase');
      if (ctx.dryRun) return { ...res, notes: [`would run: dism ${args.join(' ')}`] };
      const before = await driveSpace(`${w.systemDrive}\\`);
      progress.start('component-store: DISM /StartComponentCleanup (can take 10+ minutes)');
      const r = await run('dism.exe', args, 2 * 60 * 60_000);
      progress.done();
      const after = await driveSpace(`${w.systemDrive}\\`);
      ctx.log.debug(r.stdout);
      if (r.code !== 0) return { ...res, failed: 1, notes: [`DISM exit ${r.code}: ${r.stdout.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')}`] };
      return { ...res, deleted: 1, freedBytes: Math.max(0, (after?.free ?? 0) - (before?.free ?? 0)) };
    },
  };

  const eventArchives = fileSet({
    id: 'event-log-archives',
    group: 'system',
    title: 'Archived event logs',
    description: 'Archive-*.evtx in winevt\\Logs (written when a log is set to "archive when full"); older than --log-age.',
    risk: 'safe',
    needsAdmin: true,
    roots: () => [`${w.systemRoot}\\System32\\winevt\\Logs`],
    match: (n) => /^Archive-.*\.evtx$/i.test(n),
    minAgeDays: (ctx) => ctx.options.logAgeDays,
    pruneEmptyDirs: false,
  });

  const patchCache = fileSet({
    id: 'installer-patchcache',
    group: 'system',
    title: 'Windows Installer patch cache',
    description: 'Windows\\Installer\\$PatchCache$ — baseline copies used when uninstalling MSI patches. Uninstalling a patch may then ask for the original media.',
    risk: 'moderate',
    needsAdmin: true,
    roots: () => [`${w.systemRoot}\\Installer\\$PatchCache$`],
    minAgeDays: () => 0,
  });

  const installerDir = `${w.systemRoot}\\Installer`;
  const msiOrphans: Category = {
    id: 'msi-orphans',
    group: 'system',
    title: 'Orphaned Windows Installer packages',
    description:
      'MSI/MSP files in Windows\\Installer no installed product or patch references (MSI API + registry). Moved to --quarantine if given, else deleted. Only when picked by ID.',
    risk: 'caution',
    needsAdmin: true,
    explicitOnly: true,
    async scan(ctx): Promise<ScanResult> {
      if (!isWindows) return emptyScan();
      const refs = await msiReferences();
      const pkgs = await installerPackages(installerDir);
      let orphans;
      try {
        orphans = findOrphans(pkgs, refs.refs);
      } catch (e) {
        return emptyScan([(e as Error).message]);
      }
      const res = emptyScan();
      for (const o of orphans) {
        res.items.push({ path: o.path, root: installerDir, bytes: o.bytes, files: 1, detail: `modified ${fmtDate(o.mtime)}` });
        res.bytes += o.bytes;
        res.files++;
      }
      res.items.sort((a, b) => b.bytes - a.bytes);
      res.notes.push(`${pkgs.length} packages, ${refs.refs.size} referenced (MSI API ${refs.fromCom}, registry ${refs.fromRegistry})`);
      if (!ctx.admin) res.notes.push('not elevated — references may be incomplete, cleaning is disabled');
      res.notes.push(ctx.options.quarantine ? `clean moves them to ${ctx.options.quarantine}` : 'tip: --quarantine D:\\msi-quarantine moves them instead of deleting');
      return res;
    },
    async clean(ctx, scan) {
      const res = emptyClean();
      const q = ctx.options.quarantine;
      if (q) {
        if (!path.isAbsolute(q)) return { ...res, notes: ['--quarantine must be an absolute path'] };
        if (path.parse(q).root.toLowerCase() === path.parse(installerDir).root.toLowerCase())
          return { ...res, notes: ['--quarantine is on the same drive as Windows — moving there frees nothing; pick another drive'] };
      }
      // Re-check against fresh references right before touching anything.
      const refs = await msiReferences();
      let still: Set<string>;
      try {
        still = new Set(findOrphans(scan.items, refs.refs).map((i) => i.path.toLowerCase()));
      } catch (e) {
        return { ...res, notes: [(e as Error).message] };
      }
      for (const item of scan.items) {
        if (!still.has(item.path.toLowerCase())) {
          ctx.log.warn(`kept (now referenced): ${item.path}`);
          continue;
        }
        if (!isSafeTarget(item.path, installerDir) || path.dirname(item.path).toLowerCase() !== installerDir.toLowerCase()) {
          ctx.log.warn(`refused: ${item.path}`);
          continue;
        }
        let ok = true;
        if (!ctx.dryRun) ok = q ? await moveFile(item.path, path.join(q, path.basename(item.path))) : await deleteFile(item.path);
        if (ok) {
          res.deleted++;
          res.freedBytes += item.bytes;
          ctx.log.debug(`${ctx.dryRun ? '[dry-run] ' : ''}${q ? `moved to ${q}` : 'deleted'} ${item.path} (${fmtBytes(item.bytes)})`);
        } else res.failed++;
      }
      if (res.failed) res.notes.push(`${res.failed} packages could not be ${q ? 'moved' : 'deleted'}`);
      return res;
    },
  };

  return [temp, wuCache, winLogs, eventArchives, crashDumps, wer, recycleBin, hiberfil, componentStore, patchCache, msiOrphans, shadow, pagefile];
}
