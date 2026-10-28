// The plugin's MCP server (agy-plugin-porter_cli) over stdio, from a built plugin,
// with a stand-in agy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPlugin } from '../scripts/build-plugin.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const STUB = fileURLToPath(new URL('./agy-stub.mjs', import.meta.url));
let server;
let agyLog;
let nextId = 1;
const pending = new Map();

before(() => {
  const { dir } = buildPlugin({ outRoot: mkdtempSync(join(tmpdir(), 'porter-build-')), tar: false });
  const tmp = mkdtempSync(join(tmpdir(), 'porter-mcp-'));
  agyLog = join(tmp, 'agy.log');
  server = spawn(process.execPath, [join(dir, 'mcp', 'server.mjs')], {
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, AGY_PORTER_AGY: STUB, AGY_STUB_LOG: agyLog },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
});
after(() => server.kill());

const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const callTool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

test('initialize and tools/list: port_preview and port_install', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'agy-plugin-porter');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  const { tools } = (await rpc('tools/list', {})).result;
  assert.deepEqual(tools.map((t) => t.name), ['port_preview', 'port_install']);
  assert.deepEqual(tools[1].inputSchema.required, ['previewId', 'acceptedTier']);
});

test('port_preview reports; port_install refuses other consent, then installs the preview', async () => {
  const preview = await callTool('port_preview', { source: fixture('cursor'), slug: 'cursor-rules' });
  assert.ok(!preview.isError, preview.content[0].text);
  const text = preview.content[0].text;
  assert.match(text, /cursor-rules \(cursor\), TIER_1_TELEMETRY/);
  assert.match(text, /agy plugin validate: passed/);
  const [, previewId, tier, flags] = /previewId "(\w+)", acceptedTier "(\w+)", acceptedFlags "(\w*)"/.exec(text);

  const refused = await callTool('port_install', { previewId, acceptedTier: tier, acceptedFlags: 'beef' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /audit findings differ/);

  const done = await callTool('port_install', { previewId, acceptedTier: tier, acceptedFlags: flags });
  assert.ok(!done.isError, done.content[0].text);
  assert.match(done.content[0].text, /Installed cursor-rules/);
  assert.ok(readFileSync(agyLog, 'utf8').includes('"install"'));
  assert.match((await callTool('port_install', { previewId, acceptedTier: tier, acceptedFlags: flags })).content[0].text, /no such preview/);
});

test('a failing port and an unknown tool come back as tool errors', async () => {
  const bad = await callTool('port_preview', { source: 'not a path or repo' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /neither an existing path nor owner\/repo/);
  assert.equal((await callTool('nope', {})).isError, true);
  assert.equal((await rpc('nope/method', {})).error.code, -32601);
});
