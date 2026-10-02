import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isSafeTarget, rejectCustomRoot, rejectLogDir, trimActiveLog } from '../src/lib/fsops';
import { winPaths } from '../src/lib/sys';

const w = winPaths();

test('isSafeTarget: only strictly inside the root, never into protected folders', () => {
  assert.equal(isSafeTarget('D:\\logs\\a.log', 'D:\\logs'), true);
  assert.equal(isSafeTarget('D:\\logs', 'D:\\logs'), false);
  assert.equal(isSafeTarget('D:\\logs2\\a.log', 'D:\\logs'), false);
  assert.equal(isSafeTarget('D:\\logs\\..\\x.txt', 'D:\\logs'), false);
  // A root inside a protected folder may be cleaned (built-in categories like Installer\$PatchCache$) …
  assert.equal(isSafeTarget(`${w.systemRoot}\\Installer\\$PatchCache$\\x.msp`, `${w.systemRoot}\\Installer\\$PatchCache$`), true);
  assert.equal(isSafeTarget(`${w.systemRoot}\\System32\\winevt\\Logs\\Archive-a.evtx`, `${w.systemRoot}\\System32\\winevt\\Logs`), true);
  // … but a broad root never reaches into one.
  assert.equal(isSafeTarget(`${w.systemRoot}\\System32\\kernel32.dll`, `${w.systemDrive}\\`), false);
  assert.equal(isSafeTarget(`${w.programFiles}\\nginx\\nginx.exe`, `${w.systemDrive}\\`), false);
});

test('rejectCustomRoot and rejectLogDir', () => {
  assert.ok(rejectCustomRoot('C:\\'));
  assert.ok(rejectCustomRoot('relative\\path'));
  assert.ok(rejectCustomRoot(w.systemRoot));
  assert.equal(rejectCustomRoot('D:\\Apps\\MyApi\\logs'), undefined);
  // Log folders may live in an app folder under Program Files, never in Windows.
  assert.equal(rejectLogDir(`${w.programFiles}\\nginx\\logs`), undefined);
  assert.ok(rejectLogDir(w.programFiles));
  assert.ok(rejectLogDir(`${w.systemRoot}\\Logs`));
  assert.ok(rejectLogDir('D:\\'));
});

test('trimActiveLog keeps the tail from a line start while a writer keeps appending', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dj-trim-'));
  const file = path.join(dir, 'access.log');
  const line = (i: number) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(80)}\n`;
  let body = '';
  for (let i = 0; i < 20_000; i++) body += line(i);
  writeFileSync(file, body);
  const before = body.length;

  // An appending writer, like nginx or a pm2 app.
  const ws = createWriteStream(file, { flags: 'a' });
  let n = 100_000;
  const timer = setInterval(() => ws.write(line(n++)), 2);
  await new Promise((r) => setTimeout(r, 50));

  const r = await trimActiveLog(file, 64 * 1024);
  assert.ok(r, 'trim succeeded');
  assert.ok(r.freed > before - 128 * 1024, `freed ${r.freed}`);

  await new Promise((r2) => setTimeout(r2, 100));
  clearInterval(timer);
  await new Promise<void>((r2) => ws.end(r2));

  const after = readFileSync(file, 'utf8');
  assert.ok(after.length < 200 * 1024, `size after ${after.length}`);
  assert.ok(after.startsWith('line '), 'starts at a line boundary');
  // New lines written after the trim are at the end of the file.
  assert.match(after.trimEnd().split('\n').pop()!, /^line 1\d{5} x+$/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('trimActiveLog leaves small files alone', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dj-trim-'));
  const file = path.join(dir, 'small.log');
  writeFileSync(file, 'a\nb\n');
  assert.deepEqual(await trimActiveLog(file, 1024), { freed: 0, size: 4 });
  assert.equal(await trimActiveLog(path.join(dir, 'missing.log'), 10), undefined);
  await fsp.rm(dir, { recursive: true, force: true });
});
