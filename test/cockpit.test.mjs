// The cockpit sidecar from a built plugin, on a port and token chosen here (as the app
// does), with a stand-in agy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPlugin } from '../scripts/build-plugin.mjs';
import { startSidecar } from './mod-helpers.mjs';
import { tempDir } from './temp.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const STUB = fileURLToPath(new URL('./agy-stub.mjs', import.meta.url));
let s;
let agyLog;

before(async () => {
  const outRoot = tempDir('porter-build-');
  buildPlugin({ outRoot, tar: false });
  const tmp = tempDir('porter-cockpit-');
  agyLog = join(tmp, 'agy.log');
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp, AGY_PORTER_PREVIEWS_DIR: join(tmp, 'previews'), AGY_PORTER_AGY: STUB, AGY_STUB_LOG: agyLog });
  s = await startSidecar(join(outRoot, 'agy-plugin-porter'), 'cockpit');
});
after(() => s?.close());

const base = () => `http://127.0.0.1:${s.info.port}`;
const post = (path, body) => fetch(`${base()}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': s.info.token }, body: JSON.stringify(body),
});

test('serves sidecar-kit assets from the bundled kit, without a token, even with no Language Server', async () => {
  for (const [path, type, marker] of [
    ['/agy-ui.css', 'text/css', '.agy-card'],
    ['/agy-ui.js', 'application/javascript', 'AgyUI'],
    ['/shell.css', 'text/css', '--agy-ink'],
    ['/shell.js', 'application/javascript', 'theme-change'],
  ]) {
    const res = await fetch(`${base()}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type), path);
    assert.ok((await res.text()).includes(marker), `${path} has ${marker}`);
  }
  const host = await fetch(`${base()}/compiled_tailwind.css`);
  assert.equal(host.status, 200, 'the host stylesheet route answers even when there is no Language Server to fetch from');
  assert.match(host.headers.get('content-type'), /text\/css/);
});

test('the view files load without a token; the API needs one', async () => {
  for (const f of ['ui.html', 'ui.js', 'ui.css']) assert.equal((await fetch(`${base()}/${f}`)).status, 200, f);
  assert.equal((await fetch(`${base()}/api/previews`)).status, 401);
  assert.equal((await fetch(`${base()}/api/previews`, { headers: { 'X-Sidecar-Token': 'f'.repeat(48) } })).status, 401);
  assert.deepEqual(await s.call('/api/previews'), { busy: false, previews: [] });
  assert.ok(JSON.parse(readFileSync(join(s.data, 'server_info.json'), 'utf8')).pid > 0);
});

test('preview, refused install, install, then the preview is gone', async () => {
  const res = await post('/api/preview', { source: fixture('cursor'), slug: 'cursor-rules' });
  assert.equal(res.status, 200);
  const p = await res.json();
  assert.equal(p.slug, 'cursor-rules');
  assert.equal(p.report.validation.ok, true);
  assert.equal((await s.call('/api/previews')).previews[0].id, p.id);
  assert.equal((await s.call(`/api/preview?id=${p.id}`)).id, p.id);

  const refused = await post('/api/install', { previewId: p.id, acceptedTier: 'TIER_1_TELEMETRY', acceptedFlags: 'beef' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /audit findings differ/);

  const done = await post('/api/install', { previewId: p.id, acceptedTier: p.tier, acceptedFlags: p.flagsDigest });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).slug, 'cursor-rules');
  assert.ok(readFileSync(agyLog, 'utf8').includes('"install"'));
  assert.deepEqual((await s.call('/api/previews')).previews, []);
});

test('a bad source is a 400 with the porter\'s reason', async () => {
  const res = await post('/api/preview', { source: 'not a path or repo' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /neither an existing path nor owner\/repo/);
});
