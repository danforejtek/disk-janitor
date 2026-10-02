import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attributeFolders, findOrphans, normName, type InstalledApp } from '../src/lib/apps';
import { buildIndex, findNode } from '../src/lib/driveindex';

const app = (name: string, extra: Partial<InstalledApp> = {}): InstalledApp => ({ name, hidden: false, scope: 'machine', ...extra });

test('attributeFolders: location first, then name/publisher, then Windows folders, else leftover', () => {
  const apps = [
    app('Microsoft SQL Server 2019 (64-bit)', { installLocation: 'C:\\Program Files\\Microsoft SQL Server\\150\\' }),
    app('Notepad++ (64-bit x64)', { publisher: 'Notepad++ Team' }),
    app('Git', { publisher: 'The Git Development Community' }),
    app('Datadog Agent', { publisher: 'Datadog, Inc.' }),
  ];
  const r = attributeFolders(
    [
      { path: 'C:\\Program Files\\Microsoft SQL Server', bytes: 10 },
      { path: 'C:\\Program Files\\Notepad++', bytes: 5 },
      { path: 'C:\\Program Files\\Git', bytes: 4 },
      { path: 'C:\\ProgramData\\Datadog', bytes: 3 },
      { path: 'C:\\Program Files\\Common Files', bytes: 2 },
      { path: 'C:\\Program Files\\OldVendorTool', bytes: 7 },
      { path: 'C:\\Program Files\\Digi', bytes: 1 },
    ],
    apps,
  );
  const by = Object.fromEntries(r.map((f) => [path.basename(f.path), f]));
  assert.equal(by['Microsoft SQL Server']!.match, 'location');
  assert.equal(by['Notepad++']!.match, 'name');
  assert.equal(by.Git!.match, 'name');
  assert.equal(by.Datadog!.match, 'name');
  assert.equal(by['Common Files']!.match, 'system');
  assert.equal(by.OldVendorTool!.match, 'none');
  // Short names need a whole word: "Digi" must not match "Datadog" or "Git Development".
  assert.equal(by.Digi!.match, 'none');
  assert.equal(normName('Datadog, Inc.'), 'datadog');
});

test('findOrphans: unreferenced packages only, and never on an empty reference list', () => {
  const files = [{ path: 'C:\\Windows\\Installer\\1a2b.msi' }, { path: 'C:\\Windows\\Installer\\3c4d.msp' }, { path: 'C:\\Windows\\Installer\\x.ico' }];
  const refs = new Set([path.resolve('C:\\Windows\\Installer\\1A2B.msi').toLowerCase()]);
  assert.deepEqual(findOrphans(files, refs).map((f) => f.path), ['C:\\Windows\\Installer\\3c4d.msp']);
  assert.throws(() => findOrphans(files, new Set()), /refusing/);
});

test('buildIndex: folder totals, hard links counted once, top files', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dj-index-'));
  mkdirSync(path.join(root, 'a', 'deep', 'deeper'), { recursive: true });
  mkdirSync(path.join(root, 'b'));
  writeFileSync(path.join(root, 'a', 'one.bin'), Buffer.alloc(10_000));
  writeFileSync(path.join(root, 'a', 'deep', 'deeper', 'two.bin'), Buffer.alloc(5_000));
  writeFileSync(path.join(root, 'b', 'big.bin'), Buffer.alloc(50_000));
  linkSync(path.join(root, 'b', 'big.bin'), path.join(root, 'a', 'big-link.bin'));
  writeFileSync(path.join(root, 'top.txt'), 'hi');

  const idx = await buildIndex(root, { maxDepth: 2 });
  assert.equal(idx.total, 10_000 + 5_000 + 50_000 + 2);
  assert.equal(idx.hardLinkSaved, 50_000);
  assert.equal(findNode(idx, path.join(root, 'a', 'deep'))!.bytes, 5_000);
  // Deeper than maxDepth: folded into the depth-2 ancestor.
  assert.equal(findNode(idx, path.join(root, 'a', 'deep', 'deeper')), undefined);
  assert.equal(idx.tree.ownBytes, 2);
  assert.equal(idx.topFiles[0]!.bytes, 50_000);
  rmSync(root, { recursive: true, force: true });
});
