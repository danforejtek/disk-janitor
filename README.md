# disk-janitor

A single `.exe` for Windows Server that answers **"where did the disk space go?"** and cleans up the junk that piles up. You don't need Node installed on the server.

```
disk-janitor ui                   # web UI in your browser: explain, explore, clean
disk-janitor explain C:           # used space split into folders, hidden system areas and "unaccounted"
disk-janitor scan --deep          # read-only report per category, always safe
disk-janitor clean --dry-run      # show what would be deleted
disk-janitor clean                # pick categories interactively, confirm, delete
disk-janitor big --min-size 1GB   # every file over 1 GB on all fixed drives
disk-janitor du D:\ --depth 2     # biggest folders and files (WizTree-style)
disk-janitor list                 # all categories
```

**Easiest:** double-click `disk-janitor.exe`. It asks for admin rights (UAC), then opens the web UI in its own browser window. Closing that window stops the program too (after 2 minutes, so a reload doesn't kill it).

From a console, run it from an **elevated** prompt. Without elevation, system folders and other users' profiles can't be read, and admin-only categories are skipped when cleaning.

## Where did the space go? (`explain`)

`explain` walks the whole drive once and splits the used space reported by the volume into three parts:

1. **Files and folders.** On-disk size (rounded to clusters), with hard links counted once. Explorer counts WinSxS↔System32 links twice, which makes `Windows` look about twice its real size. Windows, Users (per profile and AppData), Program Files and ProgramData are broken down further.
2. **System areas no scanner lists:** `pagefile.sys`, `swapfile.sys`, `hiberfil.sys`, shadow copies (VSS) and the NTFS `$MFT`.
3. **Unaccounted.** Used space that no readable file explains. Usually it is folders this account can't read; they are listed. `--as-system` re-runs the walk as SYSTEM through a one-time scheduled task. A negative value means NTFS compression or deduplication saves space.

### "Installed apps: 25 GB", but the app list adds up to 1 GB

Settings › System › Storage › *Installed apps* adds up program **folders**. Each row in the app list only shows the size the installer wrote to the registry (`EstimatedSize`), which is often missing or stale. The Apps section of `explain` and the UI's **Apps** tab show:

- the registry total next to the measured size of Program Files, Program Files (x86), ProgramData and per-user `AppData\Local\Programs`;
- each folder matched to its installed program, first by `InstallLocation` and then by name or publisher;
- **folders that match no installed program**, often leftovers of uninstalled software. They are report-only: disk-janitor never deletes program folders;
- installer caches that no app row shows: `Windows\Installer` (with the orphaned packages counted), `$PatchCache$` and `ProgramData\Package Cache`.

## Web UI (`ui`)

`disk-janitor ui` starts a small web server inside the exe and opens it as an app window in Edge or Chrome (or in the default browser when neither is installed). While something runs, a progress card at the top of every tab shows the step, files seen, bytes and an estimated percentage.

- **Overview:** drives, plus the "where did it go" breakdown for any drive. The folder list folds open per level (Users › profile › AppData…).
- **Explore:** a treemap you can drill into, the largest folders (▸ expands a folder in place), and the largest files. Picked files can be deleted, after a confirmation that shows their size.
- **Apps:** installed programs vs their folders (grouped by Program Files, ProgramData, …), leftovers and installer caches.
- **Clean:** scan, tick categories (or *Select safe*), dry run or clean, with live progress.
- **Log:** a live log; every clean or delete also goes to `%ProgramData%\disk-janitor\logs`.

Security:
- The server listens on `127.0.0.1` only, on a random port.
- The URL printed in the console holds a one-time token. It is swapped for an HttpOnly, SameSite=Strict cookie, and every API call needs it.
- The `Host` and `Origin` headers are checked, so another website can't drive the API from your browser.
- The browser never sends a path to delete. It names categories or files from the server's own last scan, and every target goes through the same safety checks as the CLI.
- The server stops after 30 idle minutes.

On Server Core (no browser), use `--no-open` and open the URL through an SSH tunnel (`ssh -L 8080:127.0.0.1:<port> server`), or use `explain` / `clean` in the console.

## Categories

| ID | What | Risk |
|---|---|---|
| `temp` | `Windows\Temp` and every profile's `AppData\Local\Temp`, including SYSTEM and service accounts. Only files older than `--temp-age` (default 3 days). | safe |
| `wu-cache` | `SoftwareDistribution\Download` and the Delivery Optimization cache. `wuauserv`, `bits` and `dosvc` are stopped while cleaning, then restarted. | safe |
| `win-logs` | Old `*.log`, `*.cab` and `*.etl` in `Windows\Logs\{CBS,DISM,…}`, older than `--log-age` (default 14 days). | safe |
| `event-log-archives` | `Archive-*.evtx` in `winevt\Logs`, older than `--log-age` | safe |
| `crash-dumps` | `MEMORY.DMP`, Minidump, LiveKernelReports, per-user CrashDumps | moderate |
| `wer` | Windows Error Reporting queues and archives | safe |
| `recycle-bin` | `$Recycle.Bin` on every fixed drive, for all users | moderate |
| `hiberfil` | `hiberfil.sys`. Cleaning runs `powercfg /h off`. | safe |
| `component-store` | WinSxS via DISM `/AnalyzeComponentStore` and `/StartComponentCleanup` (add `--reset-base` for `/ResetBase`). Slow, so it only runs with `--deep` or `--only`. | safe |
| `installer-patchcache` | `Windows\Installer\$PatchCache$` (baseline copies for patch uninstall) | moderate |
| `msi-orphans` | `.msi`/`.msp` files in `Windows\Installer` that no installed product or patch references, checked with the MSI API **and** the registry. Moved to `--quarantine <dir on another drive>`, or deleted. Cleaned **only when named** with `--only` or ticked in the UI. | caution |
| `shadow-storage` | Shadow copy usage per volume. Report only. | info |
| `pagefile` | `pagefile.sys` and `swapfile.sys` sizes. Report only. | info |
| `node-modules` | `node_modules` of projects not installed or touched for `--nm-age` (default 60) days | moderate |
| `pnpm-store` | `pnpm store prune` on every pnpm store found, both per drive and per profile | safe |
| `pnpm-cache` / `npm-cache` / `yarn-cache` / `node-gyp-cache` | Package manager caches, for every profile | safe |
| `pm2-logs` | Logs of pm2 apps: every `PM2_HOME` (per profile, machine env, `ProgramData\pm2`, config), including custom paths from `dump.pm2`. Active logs over `--log-max-mb` (100) are **trimmed in place** to the last `--log-keep-mb` (20). Rotated logs older than `--log-age` are deleted. | safe |
| `nginx-logs` | Logs of every nginx found (running `nginx.exe`, services including nssm, `X:\nginx*`, `X:\tools\nginx*`, `nginxRoots`). Paths come from `nginx.conf` and its `include`s. Same trimming and deletion as pm2. | safe |
| `browser-cache` | Old Puppeteer and Playwright browser builds (`.cache\puppeteer`, `ms-playwright`). The newest build of each browser in each cache is kept, and so is every build that an installed `puppeteer-core`/`playwright-core` pins. Also removes leaked `puppeteer_dev_chrome_profile-*` folders in Temp. | moderate |
| `nuget-cache` | `.nuget\packages`, NuGet `v3-cache`, `plugins-cache` and `NuGetScratch`, for every profile | safe |
| `dotnet-sdks` | Installed .NET SDKs and runtimes, with older patch versions per feature band flagged. Report only; remove them with `dotnet-core-uninstall`. | info |
| `agent-diag` | Azure DevOps agent and GitHub runner `_diag` logs and `_work\_temp`, older than `--log-age` | safe |
| `agent-work` | Agent `_work\<N>` and runner `_work\<repo>` folders untouched for `--work-age` (default 30) days. Skipped while a build job is running. | moderate |
| `custom-*` | Your own folders and age rules from the config file. Optional `truncateOverMb` trims logs nobody rotates. | moderate |

`clean --safe --yes` selects only the categories marked **safe**. Groups for `--group`: `system`, `node`, `web`, `dotnet`, `custom` (`dev` means node + dotnet).

### Active logs

nginx on Windows never rotates its logs, and pm2 doesn't either without `pm2-logrotate`. The running process keeps the file open, so it can't be deleted. disk-janitor instead keeps the last `--log-keep-mb` of the file, cutting at a line break, and truncates it in place. Both nginx and Node append, so they keep writing at the new end of the file. Lines written during the few milliseconds of the trim can be lost. To keep logs small, schedule it:

```powershell
schtasks /Create /TN "disk-janitor logs" /RU SYSTEM /SC DAILY /ST 03:30 /RL HIGHEST /TR "C:\Tools\disk-janitor.exe clean --only nginx-logs,pm2-logs --yes"
```

## Safety

- `scan`, `explain`, `big` and `du` never modify anything. `clean` always scans first, shows the numbers and asks for confirmation unless you pass `--yes`.
- It never follows symlinks or junctions, so it can't escape a folder or count anything twice.
- Every delete is checked again right before it happens: the path must be strictly inside the category's root and outside `System32`, `WinSxS`, `Installer` and `Program Files`. Custom config paths that point at a drive root or a protected folder are refused. Log folders may live inside an app's folder under Program Files, but never under Windows.
- `msi-orphans` refuses to run when Windows Installer returns no references, or when the process isn't elevated. It checks the references again right before moving or deleting anything.
- Age filters use the newer of the modified time and the creation time, so freshly copied or extracted files are kept.
- Files that are in use are skipped and counted, not forced.
- `node_modules` is only removed when the parent folder has a `package.json`. The search skips `AppData`, `Program Files`, dot-folders and nvm/volta/fnm folders, so global installs and VS Code extensions are never touched.
- Hard links are understood: pnpm's `node_modules` are mostly hard links into the store, so their "freed" size excludes linked bytes. Running `node-modules` before `pnpm-store` (the default order) lets the prune free them.
- Every clean writes a log to `%ProgramData%\disk-janitor\logs`, listing each deleted file. Use `-v` to also print them on screen.
- Ctrl+C stops after the current file and still restarts any services it stopped.

## Config (optional)

Put `disk-janitor.json` next to the exe, or pass `--config <file>`. See [`disk-janitor.example.json`](disk-janitor.example.json). Command-line flags override config values.

## Building the exe

The build has to run **on Windows**, because the exe is built from the `node.exe` that runs the build. Use Node 22 or 24 LTS.

```powershell
npm install
npm test             # unit tests (esbuild + node --test)
npm run build        # → dist\disk-janitor.exe (~80–120 MB, it's node.exe + the app)
node scripts/build-sea.mjs D:\out\disk-janitor.exe   # same, other output path (e.g. while the old exe is still running)
```

The build bundles `src/` with esbuild into one CJS file (the web UI page is embedded as text). It turns that into a Node [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) blob and injects the blob into a copy of `node.exe` with postject.

The resulting exe is **unsigned**. If AppLocker, WDAC or Defender policies block unsigned binaries on your servers, sign it with your company certificate (`signtool sign …`) or ask your platform team to allow-list it.

For development without the exe: `npm start -- explain C:` (bundles, then runs with your local Node).

## Scheduled use

```powershell
# Every Sunday 03:00 as SYSTEM: only the safe categories, no prompts
schtasks /Create /TN "disk-janitor" /RU SYSTEM /SC WEEKLY /D SUN /ST 03:00 /RL HIGHEST /TR "C:\Tools\disk-janitor.exe clean --safe --yes"
```

`scan --json` and `explain --json --out file.json` give machine-readable output if you want to feed monitoring.
