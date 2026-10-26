// The Phase 2.5A smoke scenarios (spike/smoke.mjs), now against sidecars the porter
// generates from the vendored stage mods (spike/mods/*/src, upstream at the commits in
// each port.json). Offline: agy's side is played by the helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileSource, find, hasEsbuild, openView, stageSource, startSidecar, textOf, wait } from './mod-helpers.mjs';

async function stage(mod, run) {
  const { pluginDir, report } = compileSource(stageSource(mod));
  assert.deepEqual(report.unported, []);
  const s = await startSidecar(pluginDir);
  try { await run(s, report); } finally { s.close(); }
}
const hook = (s, event, payload) => s.call('/api/hook', { event, payload: { conversationId: 'c1', workspacePaths: ['C:\\work'], ...payload } });
const mcp = (s, name, args) => s.call('/api/mcp', { op: 'call', conv: 'c1', name, args });
const click = (s, node, ...args) => s.call('/api/action', { conv: 'c1', cb: (node.props.onPress ?? node.props.onSubmit).$cb, args });

test('task-board: command, pill, toggle, input, $.store per workspace', () => stage('task-board', async (s, report) => {
  assert.ok(report.ported.includes('command:/task-board'));
  const v = await openView(s, 'c1');
  await s.call('/api/view', { conv: 'c1', cwd: 'C:/work' });
  assert.ok((await s.call('/api/mcp', { op: 'list' })).tools.some((t) => t.name === 'slash_task-board'));
  const r = await mcp(s, 'slash_task-board', { args: 'Buy milk' });
  assert.match(r.text, /sidecar:\/\/task-board\/pane\/ui\.html/);
  await wait(100);
  const pane = () => v.latest('state').panes[0].tree;
  await click(s, find(pane(), (n) => n.type === 'Button' && n.props.label === '[ ] Buy milk'));
  await wait(100);
  assert.ok(find(pane(), (n) => n.props?.label === '[x] Buy milk'));
  await click(s, find(pane(), (n) => n.type === 'Input'), 'Second task');
  await wait(100);
  assert.ok(find(pane(), (n) => n.props?.label === '[ ] Second task'));
  const keys = Object.keys(JSON.parse(readFileSync(join(s.data, 'store.json'), 'utf8')));
  assert.equal(keys.length, 2);
  assert.ok(keys[0].startsWith(`workspace:${encodeURIComponent('C:\\work')}`), keys[0]);
  assert.deepEqual(v.latest('state').commands.map((c) => [c.name, c.argumentHint]), [['task-board', '[entry]']]);
  v.close();
}));

test('replay-theater: Pre/Post resume by stepIdx, turn toast, atoms redraw, drop at Stop', { skip: !hasEsbuild && 'esbuild not installed' }, () => stage('replay-theater', async (s) => {
  const v = await openView(s, 'c1');
  await hook(s, 'SessionStart', {});
  await hook(s, 'PreInvocation', {});
  const pre1 = await hook(s, 'PreToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: { TargetFile: join(s.data, 'new.txt'), CodeContent: 'a\nb\n' } } });
  assert.deepEqual([pre1.stdout, pre1.path], ['', 'next']);
  assert.equal((await hook(s, 'PostToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: {} }, error: '' })).path, 'resumed (stepIdx)');
  await hook(s, 'PreInvocation', {});
  await hook(s, 'PreToolUse', { stepIdx: 7, toolCall: { name: 'replace_file_content', args: { TargetFile: 'C:\\work\\x.js', ReplacementChunks: [{ TargetContent: 'old line', ReplacementContent: 'new line' }] } } });
  await hook(s, 'PostToolUse', { stepIdx: 7, toolCall: { name: 'replace_file_content', args: {} }, error: '' });
  await hook(s, 'PreToolUse', { stepIdx: 9, toolCall: { name: 'edit_file', args: { Path: 'C:\\work\\y.js', Target: 'q', Replacement: 'r' } } });
  await hook(s, 'PostToolUse', { stepIdx: 9, toolCall: { name: 'edit_file', args: {} }, error: 'permission denied' });
  await hook(s, 'Stop', {});
  await wait(100);
  assert.equal(v.latest('toast')?.text, 'replay-theater: 2 edits last turn. Run /replay');
  const r = await mcp(s, 'slash_replay', { args: '' });
  assert.ok(r.text.startsWith('Replaying the last turn') && r.text.includes('sidecar://replay-theater/pane/ui.html'), r.text);
  await wait(100);
  const pane = () => v.latest('state').panes[0].tree;
  assert.ok(textOf(pane()).includes('Step 1/2') && textOf(pane()).includes('+ a'));
  await click(s, find(pane(), (n) => n.type === 'Button' && n.props.label === 'Next'));
  await wait(100);
  assert.ok(textOf(pane()).includes('Step 2/2') && textOf(pane()).includes('- old line') && textOf(pane()).includes('+ new line'));
  await hook(s, 'PreInvocation', {});
  await hook(s, 'PreToolUse', { stepIdx: 12, toolCall: { name: 'write_to_file', args: { TargetFile: 'C:\\work\\z', CodeContent: 'z' } } });
  await hook(s, 'Stop', {});
  assert.equal((await s.call('/api/debug')).instances.find((i) => i.conv === 'c1').pending, 0);
  v.close();
}));

test('side-pane: own tools, prompt.context once per turn, prompt.fill copies, ui.close', { skip: !hasEsbuild && 'esbuild not installed' }, () => stage('side-pane', async (s, report) => {
  assert.ok(report.ported.includes('mcp:side-pane'));
  const v = await openView(s, 'c1');
  await s.call('/api/view', { conv: 'c1', cwd: 'C:/work' });
  const list = (await s.call('/api/mcp', { op: 'list' })).tools;
  const upd = list.find((t) => t.name === 'update');
  assert.ok(upd && list.some((t) => t.name === 'clear') && list.some((t) => t.name === 'slash_side-pane'));
  assert.ok(upd.description.includes('Fill the side pane') && upd.inputSchema.required?.[0] === 'markdown');
  const pre = await hook(s, 'PreInvocation', {});
  assert.match(pre.stdout, /"systemMessage":\{"systemMessage".*mcp__side-pane__update/);
  assert.equal((await hook(s, 'PreInvocation', {})).stdout, '{}');
  assert.equal((await mcp(s, 'update', { markdown: '## Plan\n1. Option one\n2. Option two' })).text, 'Side pane updated.');
  await wait(100);
  const pane = () => v.latest('state')?.panes[0]?.tree;
  assert.ok(find(pane(), (n) => n.type === 'Markdown' && n.props.text === '2. Option two'));
  await click(s, find(pane(), (n) => n.type === 'Button' && textOf(n) === 'quote'));
  await wait(100);
  assert.equal(v.latest('fill')?.text, '> 1. Option one\n');
  const bad = await mcp(s, 'update', { markdown: 5 });
  assert.deepEqual([bad.isError, bad.text], [true, 'markdown must be a string.']);
  await s.call('/api/close', { conv: 'c1', id: 'side-pane' });
  await mcp(s, 'update', { markdown: '1. again' });
  await wait(100);
  assert.equal(v.latest('state').panes.length, 0);
  assert.ok((await mcp(s, 'slash_side-pane', { args: '' })).text.startsWith('Side pane opened.'));
  v.close();
}));
