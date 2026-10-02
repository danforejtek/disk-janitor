import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { buildOptions } from '../src/config';
import { Logger } from '../src/lib/logger';
import { createUiServer, refuseFileDelete } from '../src/ui/server';
import { winPaths } from '../src/lib/sys';

let ui: ReturnType<typeof createUiServer>;
let port = 0;
const token = 'a'.repeat(48);

before(async () => {
  ui = createUiServer({ options: buildOptions({}, {}), dryRun: false, admin: false, log: new Logger(false) }, { port: 0, token });
  port = (await ui.listen()).port;
});
after(() => ui.close());

function req(p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
const cookie = { Cookie: `dj_token=${token}` };

test('API needs the token', async () => {
  assert.equal((await req('/api/drives')).status, 403);
  assert.equal((await req('/api/drives', { headers: { Cookie: 'dj_token=wrong' } })).status, 403);
  assert.equal((await req('/api/drives', { headers: cookie })).status, 200);
});

test('token in the URL is swapped for an HttpOnly SameSite=Strict cookie', async () => {
  const r = await req(`/?t=${token}`);
  assert.equal(r.status, 303);
  assert.match(String(r.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  assert.equal((await req('/')).status, 403);
  const page = await req('/', { headers: cookie });
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>disk-janitor<\/title>/);
});

test('wrong Host header is rejected (DNS rebinding)', async () => {
  assert.equal((await req('/api/drives', { headers: { ...cookie, Host: `evil.example:${port}` } })).status, 403);
});

test('POST needs same origin and JSON', async () => {
  const json = { ...cookie, 'Content-Type': 'application/json' };
  assert.equal((await req('/api/cancel', { method: 'POST', headers: { ...json, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await req('/api/cancel', { method: 'POST', headers: { ...cookie, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await req('/api/cancel', { method: 'POST', headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: '{}' })).status, 200);
});

test('clean / delete only accept server-side IDs', async () => {
  const json = { ...cookie, 'Content-Type': 'application/json' };
  const clean = await req('/api/clean', { method: 'POST', headers: json, body: JSON.stringify({ scanId: 'nope', ids: ['temp'], dryRun: false }) });
  assert.equal(clean.status, 404);
  const del = await req('/api/files/delete', { method: 'POST', headers: json, body: JSON.stringify({ explainId: 'nope', fileIds: [1] }) });
  assert.equal(del.status, 404);
});

test('refuseFileDelete protects Windows and system files', () => {
  const w = winPaths();
  const root = `${w.systemDrive}\\`;
  assert.ok(refuseFileDelete(`${w.systemDrive}\\pagefile.sys`, root));
  assert.ok(refuseFileDelete(`${w.systemRoot}\\System32\\drivers\\etc\\hosts`, root));
  assert.ok(refuseFileDelete(`${w.systemRoot}\\Temp\\x.tmp`, root));
  assert.ok(refuseFileDelete(`${w.programFiles}\\App\\app.exe`, root));
  assert.equal(refuseFileDelete(`${w.systemDrive}\\Users\\me\\Downloads\\big.iso`, root), undefined);
});
