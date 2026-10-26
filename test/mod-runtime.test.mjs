// The compiled claude-mod fixture's sidecar, hook forwarder and MCP server as
// separate processes, the way agy runs them (plan §6).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGY_TOOLS, TOOLS } from '../lib/tool-map.mjs';
import { removeServerInfoIfOurs, writeServerInfo } from '../scripts/mod-runtime/lifecycle.mjs';
import { claudeToolName } from '../scripts/mod-runtime/tool-calls.mjs';
import { compileSource, find, fixture, hasEsbuild, openView, runHook, startSidecar, tempDir, textOf, wait } from './mod-helpers.mjs';

const tsx = { skip: !hasEsbuild && 'esbuild not installed' };
// Recorded from a live agy PreToolUse (docs/agy-baseline.md), with the fixture's marker.
const livePre = (command, stepIdx = 3) => ({
  conversationId: 'c8a47aab-72dd-4111-8c63-c759cba565b4', stepIdx, modelName: 'gemini-4-argon-medium', workspacePaths: ['C:/scratch/ws'],
  toolCall: { args: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: `Run ${command}` }, name: 'run_command' },
});

test('fixture sidecar: draws the pane, denies porter-fixture-deny through hook.mjs, counts it', tsx, async () => {
  const { pluginDir } = compileSource(fixture('claude-mod'));
  const s = await startSidecar(pluginDir);
  try {
    const conv = livePre('x').conversationId;
    const v = await openView(s, conv);
    const pane = () => v.latest('state')?.panes[0]?.tree;
    assert.ok(find(pane(), (n) => textOf(n) === 'PORTER_FIXTURE_MOD_MARKER'), JSON.stringify(v.latest('state')));
    assert.match(textOf(pane()), /Denied calls: 0/);

    const allowed = await runHook(s, 'PreToolUse', livePre('npm test', 2));
    assert.deepEqual([allowed.code, allowed.stdout], [0, '']);
    assert.deepEqual((await runHook(s, 'PostToolUse', { ...livePre('npm test', 2), error: '' })).stdout, '{}');

    const denied = await runHook(s, 'PreToolUse', livePre('echo porter-fixture-deny'));
    assert.equal(denied.code, 0);
    assert.deepEqual(JSON.parse(denied.stdout), { decision: 'deny', reason: 'fixture-claude-mod: blocked by fixture policy' });
    await wait(100);
    assert.match(textOf(pane()), /Denied calls: 1/);
    assert.equal(v.latest('status')?.text, 'porter fixture: denied 1');
    v.close();
  } finally {
    s.close();
  }
});

test('placement: only visible views count; the API needs the token, the view files do not', tsx, async () => {
  const { pluginDir } = compileSource(fixture('claude-mod'));
  const s = await startSidecar(pluginDir);
  try {
    const hidden = await openView(s, 'c2', { visible: false });
    const views = async () => (await s.call('/api/debug')).instances.find((i) => i.conv === 'c2');
    assert.deepEqual([(await views()).views, (await views()).visibleViews], [1, 0]);
    await s.call('/api/visibility', { conv: 'c2', view: hidden.view, visible: true });
    assert.equal((await views()).visibleViews, 1);
    await s.call('/api/visibility', { conv: 'c2', view: hidden.view, visible: false });
    assert.equal((await views()).visibleViews, 0);
    hidden.close();
    const base = `http://127.0.0.1:${s.info.port}`;
    assert.equal((await fetch(`${base}/api/debug`)).status, 401);
    assert.equal((await fetch(`${base}/api/debug`, { headers: { 'X-Sidecar-Token': 'f'.repeat(48) } })).status, 401);
    for (const f of ['ui.html', 'ui.js', 'ui-draw.js']) assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
  } finally {
    s.close();
  }
});

test('hook.mjs fails open when the sidecar is gone or server_info.json is stale', tsx, async () => {
  const { pluginDir } = compileSource(fixture('claude-mod'));
  const s = await startSidecar(pluginDir);
  s.close();
  await wait(200);
  const stale = await runHook(s, 'PreToolUse', livePre('echo porter-fixture-deny'));
  assert.deepEqual([stale.code, stale.stdout], [0, '']);
  assert.match(stale.stderr, /not blocking/);
  assert.equal((await runHook(s, 'Stop', {})).stdout, '{}');
  const none = await runHook({ ...s, env: { ...s.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDir() } }, 'PreToolUse', livePre('x'));
  assert.deepEqual([none.code, none.stdout], [0, '']);
  assert.match(none.stderr, /no server_info\.json/);
});

test('mcp-entry: with the sidecar down, lists the scanned tools and fails calls clearly', async () => {
  const src = tempDir('porter-mcp-src-');
  cpSync(fixture('claude-mod-transcript'), src, { recursive: true });
  writeFileSync(join(src, 'hooks/register.js'), "export function register(on) {\n  on('session.start', async ($, e, next) => { await $.tool.register({ name: 'add', description: 'Add a note.' }); await $.command.register({ name: 'notes' }); return next(e) })\n  on('ui.render', { component: 'Pane' }, async () => null)\n}\n");
  const { pluginDir } = compileSource(src);
  const child = spawn(process.execPath, [join(pluginDir, 'sidecars/pane/mcp-entry.mjs')], { env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDir() } });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const ask = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 200 && !replies.some((r) => r.id === id); i++) await wait(50);
    return replies.find((r) => r.id === id);
  };
  try {
    assert.equal((await ask(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'fixture-claude-mod-transcript');
    assert.deepEqual((await ask(2, 'tools/list', {})).result.tools.map((t) => t.name), ['add', 'slash_notes']);
    const call = (await ask(3, 'tools/call', { name: 'add', arguments: {} })).result;
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /isn't running, so add can't run/);
  } finally {
    child.kill();
  }
});

test('server_info.json is removed only while it still holds our pid', () => {
  const dir = tempDir();
  writeServerInfo(dir, { host: '127.0.0.1', port: 1, token: 'a' });
  assert.equal(removeServerInfoIfOurs(dir, process.pid + 1), false);
  assert.ok(existsSync(join(dir, 'server_info.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'server_info.json'), 'utf8')).pid, process.pid);
  assert.equal(removeServerInfoIfOurs(dir), true);
  assert.equal(existsSync(join(dir, 'server_info.json')), false);
});

test("the runtime's tool names agree with lib/tool-map.mjs", () => {
  for (const agy of AGY_TOOLS) {
    const claude = claudeToolName(agy);
    assert.ok(TOOLS.claude[claude]?.includes(agy), `${agy} -> ${claude}`);
  }
});
