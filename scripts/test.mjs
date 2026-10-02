// Bundles test/*.test.ts with esbuild (same loaders as the app) and runs them with node --test.
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'test');
rmSync(out, { recursive: true, force: true });
const entries = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(root, 'test', f));
await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: out,
  outExtension: { '.js': '.cjs' },
  loader: { '.html': 'text' },
  logLevel: 'warning',
});
const files = readdirSync(out).filter((f) => f.endsWith('.cjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
