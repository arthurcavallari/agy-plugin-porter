// The runtime's pause-and-resume model for tool.call (plan §5.2), driven in process:
// agy's PreToolUse and PostToolUse are separate hook runs, so a handler waiting in
// next() is parked at Pre and resumed at the matching Post.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { Engine } from '../scripts/mod-runtime/engine.mjs';
import { tempDir, wait } from './mod-helpers.mjs';

const MOD = `
export function register(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.command === 'deny me') return { deny: 'no' }
    if (e.command === 'rewrite') return next({ ...e, command: 'echo safe' })
    if (e.command === 'slow') await new Promise((r) => setTimeout(r, 150))
    if (e.command === 'throw') throw new Error('boom')
    const r = await next(e)
    globalThis.porterResults.push({ command: e.command, r })
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guard failed' }))
  on('prompt.context', async ($, e, next) => {
    const c = await next(e)
    return { ...c, blocks: [...c.blocks, { name: 'x', text: 'NUDGE' }] }
  })
  on('command.run', async ($, e) => { await $.ui.toast('hi'); return { text: 'ran' } })
}
`;

function engine(opts = {}) {
  const dir = tempDir('porter-cont-');
  writeFileSync(join(dir, 'mod.mjs'), MOD);
  globalThis.porterResults = [];
  return new Engine({
    mod: { plugin: 'p', sidecar: 'pane', mcpServer: 'p', allow: opts.allow ?? [] }, modUrl: pathToFileURL(join(dir, 'mod.mjs')).href,
    dataDir: dir, emit: () => {}, visibleViews: () => 0, log: () => {}, preToolWaitMs: 100, ...opts,
  });
}
const bash = (stepIdx, command) => ({ conversationId: 'c1', stepIdx, toolCall: { name: 'run_command', args: { CommandLine: command } } });
const post = (stepIdx, error = '') => ({ conversationId: 'c1', stepIdx, toolCall: { name: 'run_command', args: {} }, error });

test('Pre then Post resumes the handler, matched by stepIdx', async () => {
  const eng = engine();
  assert.deepEqual(await eng.hook('PreToolUse', bash(4, 'ls')), { stdout: '', path: 'next' });
  assert.deepEqual(await eng.hook('PreToolUse', bash(5, 'pwd')), { stdout: '', path: 'next' });
  assert.deepEqual(globalThis.porterResults, []);
  assert.equal((await eng.hook('PostToolUse', post(5))).path, 'resumed (stepIdx)');
  assert.equal((await eng.hook('PostToolUse', post(4, 'exit 1'))).path, 'resumed (stepIdx)');
  await wait(10);
  assert.deepEqual(globalThis.porterResults.map((x) => [x.command, x.r.isError]), [['pwd', false], ['ls', true]]);
  assert.equal(globalThis.porterResults[1].r.error, 'exit 1');
});

test('a Pre with no Post is dropped at Stop', async () => {
  const eng = engine();
  await eng.hook('PreToolUse', bash(7, 'ls'));
  await eng.hook('Stop', { conversationId: 'c1' });
  await wait(10);
  assert.deepEqual(globalThis.porterResults.map((x) => [x.command, x.r.isError, x.r.text]), [['ls', true, 'no PostToolUse before Stop']]);
  assert.equal((await eng.get('c1')).pending.length, 0);
});

test('a Pre with no Post is dropped after the leak timeout', async () => {
  const eng = engine({ pendingMaxMs: 30 });
  await eng.hook('PreToolUse', bash(8, 'ls'));
  await wait(50);
  assert.equal((await eng.hook('PostToolUse', post(99))).path, 'no suspended handler');
  await wait(10);
  assert.deepEqual(globalThis.porterResults.map((x) => x.r.text), ['no PostToolUse in time']);
});

test('changed input becomes an agy overwrite under agy arg names; deny becomes deny', async () => {
  const eng = engine();
  const rewrite = await eng.hook('PreToolUse', bash(1, 'rewrite'));
  assert.deepEqual(JSON.parse(rewrite.stdout), { decision: 'allow', overwrite: { CommandLine: 'echo safe' } });
  assert.equal(rewrite.path, 'next(changed)');
  assert.deepEqual(JSON.parse((await eng.hook('PreToolUse', bash(2, 'deny me'))).stdout), { decision: 'deny', reason: 'no' });
  assert.deepEqual(JSON.parse((await eng.hook('PreToolUse', bash(3, 'throw'))).stdout), { decision: 'deny', reason: 'guard failed' });
});

test('a slow handler gets no opinion at Pre, and still resumes at Post', async () => {
  const eng = engine();
  assert.deepEqual(await eng.hook('PreToolUse', bash(6, 'slow')), { stdout: '', path: 'timeout' });
  await wait(200);
  assert.equal((await eng.hook('PostToolUse', post(6))).path, 'resumed (stepIdx)');
  await wait(10);
  assert.deepEqual(globalThis.porterResults.map((x) => x.command), ['slow']);
});

test('prompt.context: one systemMessage step on the first PreInvocation of a turn only', async () => {
  const eng = engine();
  const first = await eng.hook('PreInvocation', { conversationId: 'c1' });
  assert.deepEqual(JSON.parse(first.stdout), { injectSteps: [{ systemMessage: { systemMessage: 'NUDGE' } }] });
  assert.equal((await eng.hook('PreInvocation', { conversationId: 'c1' })).stdout, '{}');
  await eng.hook('Stop', { conversationId: 'c1' });
  assert.match((await eng.hook('PreInvocation', { conversationId: 'c1' })).stdout, /NUDGE/);
});

test('$ outside the static scan throws; scanned but unsupported rejects', async () => {
  const bare = engine();
  await assert.rejects(bare.runCommand(await bare.get('c1'), 'x', '', 'view'), /\$\.ui\.toast wasn't in the mod's static scan/);
  const eng = engine({ allow: ['ui.toast', 'process.run', 'model.complete'] });
  const inst = await eng.get('c1');
  assert.deepEqual(await eng.runCommand(inst, 'x', '', 'view'), { isError: false, text: 'ran' });
  await assert.rejects(inst.$.process.run(['ls']), /not available in the Antigravity port/);
  assert.equal(await inst.$.model.complete({}), undefined);
});
