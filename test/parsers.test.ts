import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isBuildDir, parseDotnetList, readAgent, supersededDotnet } from '../src/categories/dotnet';
import { cmpVersion, parsePlaywrightBrowsers, parsePuppeteerRevisions, pm2DumpLogs, removableBuilds } from '../src/categories/node';
import { nginxLogs, parseNginxConf } from '../src/categories/web';
import { parseSizeArg } from '../src/commands/du';

test('parseNginxConf: includes and log directives, comments and off ignored', () => {
  const conf = parseNginxConf(`
    error_log  logs/error.log  warn;   # main error log
    http {
      include       mime.types;
      include conf.d/*.conf;
      access_log  "D:/weblogs/main_access.log"  main;
      # access_log logs/commented.log;
      server { access_log off; error_log stderr; access_log logs/$host.access.log; }
    }`);
  assert.deepEqual(conf.includes, ['mime.types', 'conf.d/*.conf']);
  assert.deepEqual(conf.logs, ['logs/error.log', 'D:/weblogs/main_access.log']);
  assert.deepEqual(conf.variableLogs, ['logs/$host.access.log']);
});

test('nginxLogs: follows include globs, resolves relative to the prefix, adds defaults', async () => {
  const prefix = mkdtempSync(path.join(os.tmpdir(), 'dj-nginx-'));
  mkdirSync(path.join(prefix, 'conf', 'conf.d'), { recursive: true });
  writeFileSync(path.join(prefix, 'conf', 'nginx.conf'), 'http { include conf.d/*.conf; }');
  writeFileSync(path.join(prefix, 'conf', 'conf.d', 'api.conf'), 'server { access_log logs/api_access.log; }');
  writeFileSync(path.join(prefix, 'conf', 'conf.d', 'skip.txt'), 'server { access_log logs/not_included.log; }');
  const r = await nginxLogs(prefix);
  const rel = r.active.map((f) => path.relative(prefix, f)).sort();
  assert.deepEqual(rel, [path.join('logs', 'api_access.log'), path.join('logs', 'error.log')]);
  assert.ok(r.dirs.some((d) => d === path.join(prefix, 'logs')));
  rmSync(prefix, { recursive: true, force: true });
});

test('pm2DumpLogs: custom log paths of saved apps', () => {
  const dump = JSON.stringify([
    { name: 'api', pm_out_log_path: 'D:\\logs\\api-out.log', pm_err_log_path: 'D:\\logs\\api-err.log' },
    { name: 'worker', pm_out_log_path: 'NUL', pm_err_log_path: 'relative.log' },
  ]);
  assert.deepEqual(pm2DumpLogs(dump), [path.normalize('D:\\logs\\api-out.log'), path.normalize('D:\\logs\\api-err.log')]);
  assert.deepEqual(pm2DumpLogs('not json'), []);
});

test('puppeteer/playwright: pinned builds and which ones may go', () => {
  const rev = `export const PUPPETEER_REVISIONS = Object.freeze({
    chrome: '131.0.6778.204',
    'chrome-headless-shell': '131.0.6778.204',
    firefox: 'stable_133.0',
  });`;
  assert.deepEqual(parsePuppeteerRevisions(rev), ['chrome/131.0.6778.204', 'chrome-headless-shell/131.0.6778.204', 'firefox/stable_133.0']);
  assert.deepEqual(parsePlaywrightBrowsers('{"browsers":[{"name":"chromium-headless-shell","revision":"1140"},{"name":"firefox","revision":"1463"}]}'), [
    'chromium_headless_shell-1140',
    'firefox-1463',
  ]);
  assert.ok(cmpVersion('131.0.6778.204', '130.0.6723.58') > 0);
  assert.ok(cmpVersion('9.0.1', '10.0.0') < 0);

  const b = (browser: string, version: string) => ({ path: `C:\\cache\\${browser}\\win64-${version}`, browser: `puppeteer:${browser}`, version });
  const builds = [b('chrome', '127.0.6533.88'), b('chrome', '131.0.6778.204'), b('chrome', '133.0.6943.53'), b('chrome-headless-shell', '133.0.6943.53')];
  const gone = removableBuilds(builds, new Set(['puppeteer:chrome/131.0.6778.204'])).map((x) => x.version);
  // Newest (133) and pinned (131) stay, the only headless build stays.
  assert.deepEqual(gone, ['127.0.6533.88']);
});

test('dotnet: list parsing and superseded versions per feature band', () => {
  const sdks = parseDotnetList('8.0.100 [C:\\Program Files\\dotnet\\sdk]\r\n8.0.111 [C:\\Program Files\\dotnet\\sdk]\r\n8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n9.0.100 [C:\\Program Files\\dotnet\\sdk]', 'sdk');
  const rts = parseDotnetList('Microsoft.NETCore.App 8.0.10 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]\nMicrosoft.NETCore.App 8.0.11 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]\nMicrosoft.AspNetCore.App 8.0.11 [C:\\x]', 'runtime');
  assert.equal(sdks.length, 4);
  assert.equal(rts[0]!.dir, path.join('C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App', '8.0.10'));
  const old = supersededDotnet([...sdks, ...rts]).map((d) => `${d.name} ${d.version}`);
  assert.deepEqual(old.sort(), ['Microsoft.NETCore.App 8.0.10', 'SDK 8.0.100']);
});

test('build agents: .agent / .runner work folder and which folders are build dirs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dj-agent-'));
  writeFileSync(path.join(root, '.runner'), '\uFEFF{"agentName":"r1","workFolder":"_work"}');
  const a = await readAgent(root);
  assert.equal(a?.kind, 'github-runner');
  assert.equal(a?.work, path.join(root, '_work'));
  assert.equal(isBuildDir('azure-devops', '12'), true);
  assert.equal(isBuildDir('azure-devops', '_tool'), false);
  assert.equal(isBuildDir('azure-devops', 'SourceRootMapping'), false);
  assert.equal(isBuildDir('github-runner', 'my-repo'), true);
  assert.equal(isBuildDir('github-runner', '_actions'), false);
  rmSync(root, { recursive: true, force: true });
});

test('parseSizeArg', () => {
  assert.equal(parseSizeArg('500MB'), 500 * 1024 ** 2);
  assert.equal(parseSizeArg('1.5g'), 1.5 * 1024 ** 3);
  assert.equal(parseSizeArg('2048'), 2048);
  assert.throws(() => parseSizeArg('lots'));
});
