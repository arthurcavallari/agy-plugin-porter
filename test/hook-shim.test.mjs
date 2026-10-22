import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detect } from '../lib/detector.mjs';
import { compileHooks, writeHookPort } from '../lib/hook-compiler.mjs';
import { expandCommand, toSourcePayload, translateResult } from '../scripts/hook-shim.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Recorded from a live agy 1.4.5 PreToolUse (docs/agy-baseline.md, step 0).
const livePre = (command) => ({
  artifactDirectoryPath: 'C:/scratch/home/.gemini/antigravity-cli/brain/c8a47aab',
  conversationId: 'c8a47aab-72dd-4111-8c63-c759cba565b4',
  modelName: 'gemini-4-argon-medium',
  stepIdx: 3,
  toolCall: { args: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: `Run ${command}` }, name: 'run_command' },
  transcriptPath: 'C:/scratch/home/.gemini/antigravity-cli/brain/c8a47aab/.system_generated/logs/transcript_full.jsonl',
  workspacePaths: ['C:/scratch/ws'],
});
const pre = { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', timeout: 10 };
const session = { event: 'SessionStart', sourceEvent: 'SessionStart', dialect: 'claude', timeout: 60 };
const stop = { event: 'Stop', sourceEvent: 'Stop', dialect: 'claude', timeout: 60 };
const post = { event: 'PostToolUse', sourceEvent: 'PostToolUse', dialect: 'claude', timeout: 60 };

test('payload: agy camelCase -> Claude snake_case', () => {
  assert.deepEqual(toSourcePayload(pre, livePre('npm test')), {
    session_id: 'c8a47aab-72dd-4111-8c63-c759cba565b4',
    transcript_path: 'C:/scratch/home/.gemini/antigravity-cli/brain/c8a47aab/.system_generated/logs/transcript_full.jsonl',
    cwd: 'C:/scratch/ws',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', WaitMsBeforeAsync: 5000, toolSummary: 'Run npm test' },
  });
  const edit = toSourcePayload(post, { toolCall: { name: 'edit_file', args: { Path: 'C:/a.txt', Target: 'a', Replacement: 'b' } }, error: '' });
  assert.equal(edit.tool_name, 'Edit');
  assert.deepEqual(edit.tool_input, { file_path: 'C:/a.txt', old_string: 'a', new_string: 'b' });
  assert.deepEqual(edit.tool_response, {});
  assert.equal(toSourcePayload(session, {}).source, 'startup');
  assert.equal(toSourcePayload(stop, { executionNum: 2 }).stop_hook_active, true);
  const gemini = toSourcePayload({ ...pre, sourceEvent: 'BeforeTool', dialect: 'gemini' }, livePre('ls'));
  assert.equal(gemini.tool_name, 'run_shell_command');
  assert.equal(gemini.hook_event_name, 'BeforeTool');
});

test('expandCommand substitutes plugin variables only', () => {
  const vars = { CLAUDE_PLUGIN_ROOT: 'C:\\p q\\plug', CLAUDE_PROJECT_DIR: 'C:\\ws' };
  assert.equal(expandCommand('node "${CLAUDE_PLUGIN_ROOT}/x.mjs" $CLAUDE_PROJECT_DIR $HOME', vars),
    'node "C:\\p q\\plug/x.mjs" C:\\ws $HOME');
  assert.equal(expandCommand('node ${extensionPath}${/}x.mjs', { extensionPath: '/e' }), `node /e${sep}x.mjs`);
});

test('PreToolUse translation', () => {
  const t = (r) => translateResult(pre, { code: 0, stdout: '', stderr: '', ...r });
  assert.deepEqual(t({}), { stdout: '' });
  assert.deepEqual(t({ stdout: 'just text' }), { stdout: '' });
  assert.deepEqual(t({ stdout: '{}' }), { stdout: '' }, 'never forward {} (agy reads it as deny)');
  assert.deepEqual(JSON.parse(t({ code: 2, stderr: 'nope\r\n' }).stdout), { decision: 'deny', reason: 'nope' });
  assert.deepEqual(JSON.parse(t({ code: 2 }).stdout), { decision: 'deny', reason: 'Blocked by hook' });
  assert.deepEqual(JSON.parse(t({ stdout: '\uFEFF{"decision":"block","reason":"r"}' }).stdout), { decision: 'deny', reason: 'r' });
  assert.deepEqual(JSON.parse(t({ stdout: '{"decision":"approve"}' }).stdout), { decision: 'allow' });
  assert.deepEqual(JSON.parse(t({ stdout: '{"continue":false,"stopReason":"halt"}' }).stdout), { decision: 'deny', reason: 'halt' });
  const specific = JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check', updatedInput: { command: 'ls -la' } } });
  assert.deepEqual(JSON.parse(translateResult({ ...pre, toolName: 'run_command' }, { code: 0, stdout: specific }).stdout),
    { decision: 'ask', reason: 'check', overwrite: { CommandLine: 'ls -la' } });
});

test('non-2 failures allow with a warning (Claude semantics)', () => {
  for (const r of [{ code: 1, stderr: 'boom' }, { code: 127 }, { timedOut: true }, { spawnError: 'ENOENT' }]) {
    const out = translateResult(pre, { stdout: '{"decision":"deny"}', stderr: '', ...r });
    assert.equal(out.stdout, '');
    assert.match(out.warning, /not blocking/);
    assert.equal(translateResult(session, r).stdout, '{}');
  }
});

test('SessionStart, Stop and PostToolUse translation', () => {
  const inject = (text) => JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
  assert.equal(translateResult(session, { code: 0, stdout: 'hello\r\n' }).stdout, inject('hello'));
  assert.equal(translateResult(session, { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'ctx' } }) }).stdout, inject('ctx'));
  assert.equal(translateResult(session, { code: 0, stdout: '' }).stdout, '{}');
  assert.equal(translateResult(session, { code: 2, stdout: 'ignored', stderr: 'x' }).stdout, '{}');
  assert.deepEqual(JSON.parse(translateResult(stop, { code: 2, stderr: 'tests failing' }).stdout), { decision: 'continue', reason: 'tests failing' });
  assert.deepEqual(JSON.parse(translateResult(stop, { code: 0, stdout: '{"decision":"block","reason":"r"}' }).stdout), { decision: 'continue', reason: 'r' });
  assert.equal(translateResult(stop, { code: 0, stdout: '' }).stdout, '{}');
  const fed = translateResult(post, { code: 2, stderr: 'lint failed' });
  assert.equal(fed.stdout, '{}');
  assert.match(fed.warning, /lint failed/);
});

// End to end: port the Claude fixture into a dir whose path has a space, then run
// the shim the way agy does (cwd = plugin root, payload on stdin).
function portedClaudeFixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'porter-shim-')), 'plugin root');
  mkdirSync(dir);
  cpSync(fixture('claude'), dir, { recursive: true });
  writeHookPort(dir, compileHooks(detect(dir).hookSources, { slug: 'fixture-claude' }));
  return dir;
}
function runShim(dir, event, hook, payload) {
  const temp = mkdtempSync(join(tmpdir(), 'porter-shim-tmp-'));
  const run = spawnSync(process.execPath, ['scripts/hook-shim.mjs', '--event', event, '--hook', hook], {
    cwd: dir, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  let log = '';
  try { log = readFileSync(join(temp, 'agy-porter-fixture.log'), 'utf8'); } catch {}
  return { ...run, log };
}

test('e2e: bash-guard exit 2 becomes a JSON deny; allowed commands print nothing', () => {
  const dir = portedClaudeFixture();
  const denied = runShim(dir, 'PreToolUse', 'pretooluse-1', livePre('echo porter-fixture-deny'));
  assert.equal(denied.status, 0);
  assert.deepEqual(JSON.parse(denied.stdout), { decision: 'deny', reason: 'bash-guard: blocked by fixture policy' });
  const logged = JSON.parse(denied.log.trim());
  // Runners report temp dirs through symlinks (macOS /var) or 8.3 names (Windows).
  assert.equal(realpathSync.native(logged.pluginRoot), realpathSync.native(dir));
  assert.equal(JSON.parse(logged.stdin).tool_input.command, 'echo porter-fixture-deny');

  const allowed = runShim(dir, 'PreToolUse', 'pretooluse-1', livePre('echo porter-fixture-allow'));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});

test('e2e: SessionStart text becomes injectSteps; PostToolUse prints {}', () => {
  const dir = portedClaudeFixture();
  const started = runShim(dir, 'SessionStart', 'sessionstart-1', { conversationId: 'c', workspacePaths: [dir] });
  assert.deepEqual(JSON.parse(started.stdout), {
    injectSteps: [{ systemMessage: { systemMessage: 'fixture-claude session context: PORTER_FIXTURE_SESSION_MARKER' } }],
  });
  const posted = runShim(dir, 'PostToolUse', 'posttooluse-1', { toolCall: { name: 'edit_file', args: { Path: 'x' } } });
  assert.equal(posted.stdout, '{}');
  assert.equal(JSON.parse(posted.log.trim()).tag, 'post-edit');
});

test('e2e: crashing script and unknown hook id allow with a warning, exit 0', () => {
  const dir = portedClaudeFixture();
  writeFileSync(join(dir, 'scripts/bash-guard.mjs'), 'process.stderr.write("crash"); process.exit(1);\n');
  const crashed = runShim(dir, 'PreToolUse', 'pretooluse-1', livePre('echo porter-fixture-deny'));
  assert.equal(crashed.status, 0);
  assert.equal(crashed.stdout, '');
  assert.match(crashed.stderr, /exited with code 1; not blocking\. stderr: crash/);

  const unknown = runShim(dir, 'Stop', 'stop-9', {});
  assert.equal(unknown.status, 0);
  assert.equal(unknown.stdout, '{}');
  assert.match(unknown.stderr, /no hook "stop-9"/);
});
