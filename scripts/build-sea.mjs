// Builds dist/disk-janitor.exe as a Node.js Single Executable Application.
// Run on Windows with the Node version you want to embed (22 or 24 LTS): `npm run build`
// An optional argument writes the exe elsewhere (e.g. while the old one is still running).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const bundle = path.join(dist, 'disk-janitor.cjs');
const blob = path.join(dist, 'sea-prep.blob');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dist, process.platform === 'win32' ? 'disk-janitor.exe' : 'disk-janitor');

if (process.platform !== 'win32') console.warn('⚠ Not on Windows — this produces a binary for the current OS, not a Windows .exe.');

mkdirSync(dist, { recursive: true });

console.log('1/4 bundling');
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundle,
  legalComments: 'none',
  loader: { '.html': 'text' },
  minify: false,
});

console.log('2/4 generating SEA blob');
const seaConfig = path.join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log('3/4 copying node binary');
try {
  rmSync(exe, { force: true });
} catch (err) {
  if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
  console.error(
    `\n✖ Can't replace ${path.relative(root, exe)} — it's in use (probably still running).\n` +
      `  Close it (if it was started from an admin shell, stop it from there), or build elsewhere:\n` +
      `    node scripts/build-sea.mjs dist/disk-janitor-new.exe`,
  );
  process.exit(1);
}
copyFileSync(process.execPath, exe);
if (process.platform === 'win32') {
  // node.exe is Authenticode-signed; strip the signature so the injected binary isn't "tampered".
  try {
    execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
  } catch {
    console.log('   (signtool not found — fine, the exe will just be unsigned)');
  }
}

console.log('4/4 injecting app');
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});

console.log(`\n✔ ${path.relative(root, exe)}  (Node ${process.version})`);
