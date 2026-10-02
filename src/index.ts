import { renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { allCategories, type Ctx } from './categories';
import { cmdClean } from './commands/clean';
import { buildOptions, list, loadConfig, num, selectCategories, VERSION } from './config';
import { cmdBig, cmdDu, parseSizeArg } from './commands/du';
import { explainAsSystem, printExplain, runExplain } from './commands/explain';
import { allDriveSpace, printDrives, printEntries, scanAll, toJson } from './commands/report';
import { c, table } from './lib/format';
import { Logger } from './lib/logger';
import { installAbortHandler, installCliProgress } from './lib/progress';
import { fixedDrives, isAdmin, isWindows, parentProcessName, relaunchElevated, winPaths } from './lib/sys';
import { cmdUi } from './ui/server';

const HELP = `${c.bold('disk-janitor')} ${VERSION} — find out where disk space went on Windows Server, and clean it up

${c.bold('Usage')}
  Double-click disk-janitor.exe to open the web UI (it asks for admin rights).
  disk-janitor ui      [--port N] [--no-open]
  disk-janitor explain [drive] [--as-system] [--json] [--out file]
  disk-janitor scan    [--deep] [--only ids] [--group names] [--json]
  disk-janitor clean   [--only ids | --safe] [--dry-run] [--yes] [--deep] [--reset-base]
  disk-janitor du      [path] [--depth 1] [--top 25]
  disk-janitor big     [paths] [--min-size 500MB] [--top 50]
  disk-janitor list

${c.bold('Commands')}
  ui       Web UI in your browser (localhost only): explain, explore, clean
  explain  Where did the space go? Used space split into folders, hidden system areas
           (VSS, MFT, pagefile) and what nothing can see; installed apps vs their folders
  scan     Report reclaimable space per category (read-only, always safe)
  clean    Scan, pick categories, confirm, delete. Logs to %ProgramData%\\disk-janitor\\logs
  du       Biggest folders and files under a path (default: system drive)
  big      Every file over --min-size on all fixed drives (or the given paths), space per file type
  list     Show all categories

${c.bold('Options')}
  --only <ids>         Comma-separated category IDs (see \`list\`)
  --group <names>      system, node, web, dotnet, custom (dev = node + dotnet)
  --deep               Include slow categories (DISM component store analysis)
  --safe               clean: select every category marked "safe"
  --dry-run            clean: show what would be deleted, delete nothing
  -y, --yes            clean: don't ask for confirmation (for scripts / Task Scheduler)
  --reset-base         component-store: also run DISM /ResetBase (updates become permanent)
  --temp-age <days>    Temp files older than this (default 3)
  --log-age <days>     Logs older than this (default 14)
  --nm-age <days>      node_modules unused for this long (default 60)
  --work-age <days>    Build agent work folders unused for this long (default 30)
  --log-max-mb <n>     Trim active pm2/nginx logs bigger than this (default 100)
  --log-keep-mb <n>    How much of the end of a trimmed log to keep (default 20)
  --quarantine <dir>   msi-orphans: move packages here (another drive) instead of deleting
  --roots <paths>      Where to search for node projects, comma-separated (default: all fixed drives)
  --config <file>      JSON config (default: disk-janitor.json next to the exe)
  --as-system          explain: run the walk as SYSTEM (reads folders closed to admins)
  --json               scan / explain: machine-readable output
  --out <file>         explain --json: write to a file instead of stdout
  --port <n>           ui: port (default: random)
  --no-open            ui: print the URL, don't open a browser
  -v, --verbose        Print every file deleted (always written to the log)
  -h, --help

${c.bold('Examples')}
  disk-janitor ui
  disk-janitor explain C:
  disk-janitor clean --dry-run
  disk-janitor clean --only temp,wu-cache,nginx-logs,pm2-logs --yes
  disk-janitor clean --only msi-orphans --quarantine D:\\msi-quarantine
  disk-janitor big --min-size 1GB
`;

let doubleClick = false;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      group: { type: 'string' },
      deep: { type: 'boolean' },
      safe: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'reset-base': { type: 'boolean' },
      'temp-age': { type: 'string' },
      'log-age': { type: 'string' },
      'nm-age': { type: 'string' },
      'work-age': { type: 'string' },
      'log-max-mb': { type: 'string' },
      'log-keep-mb': { type: 'string' },
      quarantine: { type: 'string' },
      roots: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
      'as-system': { type: 'boolean' },
      depth: { type: 'string' },
      top: { type: 'string' },
      'min-size': { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      // Internal: set when started by a double-click (also passed on to the elevated copy).
      'double-click': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  // Double-clicked in Explorer: no arguments, and Explorer is the parent. Open the UI instead of
  // flashing the help text in a window that closes at once.
  if (!values['double-click'] && process.argv.length <= 2 && (await parentProcessName()) === 'explorer.exe') values['double-click'] = true;
  doubleClick = !!values['double-click'];
  const command = positionals[0] ?? (doubleClick ? 'ui' : 'help');
  if (command === 'help' || values.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig(values.config);
  const options = buildOptions(cfg, values);
  const quiet = !!values.json && (command === 'explain' || command === 'scan');

  if (doubleClick && command === 'ui') {
    process.title = 'disk-janitor — closing this window stops it';
    if (!(await isAdmin())) {
      console.log('Asking Windows for administrator rights, so system folders can be read…');
      if (await relaunchElevated(['ui', '--double-click'])) return 0;
      console.log(c.yellow('No admin rights — carrying on with what this account can read.\n'));
    }
  }

  const log = new Logger(!!values.verbose);
  const ctx: Ctx = { options, dryRun: !!values['dry-run'], admin: await isAdmin(), log };

  if (!quiet) {
    if (!isWindows) log.warn(c.yellow('Not running on Windows — Windows locations will simply be missing.'));
    if (!ctx.admin && command !== 'list') log.warn(c.yellow('Not elevated: system locations and other profiles will be partly unreadable. Run from an Administrator prompt.\n'));
  }

  const cats = allCategories(ctx);
  const select = () => selectCategories(cats, { only: list(values.only), groups: list(values.group), deep: !!values.deep });

  switch (command) {
    case 'list': {
      const rows = [[c.bold('ID'), c.bold('Group'), c.bold('Risk'), c.bold('Description')]];
      for (const x of cats) {
        const flags = [x.reportOnly && 'report only', x.deepOnly && '--deep', x.needsAdmin && 'admin', x.explicitOnly && 'only by ID'].filter(Boolean).join(', ');
        rows.push([c.cyan(x.id), x.group, x.risk, `${x.description}${flags ? c.dim(` [${flags}]`) : ''}`]);
      }
      console.log(table(rows));
      return 0;
    }

    case 'scan': {
      const sel = select();
      const drives = await allDriveSpace();
      const entries = await scanAll(ctx, sel);
      if (values.json) {
        console.log(JSON.stringify(toJson(entries, drives), null, 2));
        return 0;
      }
      printDrives(ctx, drives);
      printEntries(ctx, entries);
      log.info(c.dim(`\nNext: disk-janitor clean --dry-run   ·   disk-janitor explain ${winPaths().systemDrive}`));
      return 0;
    }

    case 'clean': {
      log.open(ctx.dryRun ? 'dry-run' : 'clean');
      try {
        return await cmdClean(ctx, select(), {
          explicit: !!(values.only || values.group),
          named: list(values.only).map((s) => s.toLowerCase()),
          yes: !!values.yes,
          safe: !!values.safe,
        });
      } finally {
        await log.close();
      }
    }

    case 'explain': {
      const drive = positionals[1] ?? winPaths().systemDrive;
      const result = values['as-system'] ? await explainAsSystem(ctx, drive) : (await runExplain(ctx, drive)).result;
      if (values.json) {
        const json = JSON.stringify(result, null, 2);
        if (values.out) {
          // Write then rename, so a reader polling for the file never sees half of it.
          writeFileSync(`${values.out}.tmp`, json);
          renameSync(`${values.out}.tmp`, values.out);
        } else console.log(json);
        return 0;
      }
      printExplain(ctx, result);
      return 0;
    }

    case 'du': {
      const target = positionals[1] ?? (isWindows ? `${winPaths().systemDrive}\\` : process.cwd());
      return cmdDu(ctx, target, Math.max(1, num(values.depth, 1, 'depth')), Math.max(1, num(values.top, 25, 'top')));
    }

    case 'big': {
      const roots = positionals.length > 1 ? positionals.slice(1) : isWindows ? await fixedDrives() : [process.cwd()];
      return cmdBig(ctx, roots, parseSizeArg(values['min-size'] ?? '500MB'), Math.max(1, num(values.top, 50, 'top')));
    }

    case 'ui':
      return cmdUi(ctx, { port: num(values.port, 0, 'port'), open: !values['no-open'], exitWhenClosed: doubleClick });

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

installAbortHandler();
installCliProgress();
main().then(
  (code) => process.exit(code),
  async (err) => {
    console.error(c.red(`error: ${(err as Error).message}`));
    // A double-clicked window closes on exit; leave the error readable.
    if (doubleClick && process.stdin.isTTY) {
      console.error('\nPress Enter to close this window.');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    }
    process.exit(1);
  },
);
