import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detect } from '../lib/detector.mjs';
import { compileHooks, writeHookPort } from '../lib/hook-compiler.mjs';
import { expandCommand, resolveHookSpawn, runCommand, shouldRun, toSourcePayload, toSourceTool, translateResult } from '../scripts/hook-shim.mjs';
import { removeLater, tempDir } from './temp.mjs';

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

test('expandCommand substitutes plugin variables only and normalizes slashes in posix mode', () => {
  const vars = { CLAUDE_PLUGIN_ROOT: 'C:\\p q\\plug', CLAUDE_PROJECT_DIR: 'C:\\ws' };
  assert.equal(expandCommand('node "${CLAUDE_PLUGIN_ROOT}/x.mjs" $CLAUDE_PROJECT_DIR $HOME', vars),
    'node "C:\\p q\\plug/x.mjs" C:\\ws $HOME');
  assert.equal(expandCommand('node ${extensionPath}${/}x.mjs', { extensionPath: '/e' }), `node /e${sep}x.mjs`);
  assert.equal(expandCommand('bash ${CLAUDE_PLUGIN_ROOT}${/}hooks${/}check.sh $CLAUDE_PROJECT_DIR', vars, { posix: true }),
    'bash "C:/p q/plug/hooks/check.sh" C:/ws');
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

test('translateResult preserves force_ask decision and toSourceTool unwraps call_mcp_tool', () => {
  const res = translateResult(
    { event: 'PreToolUse', dialect: 'claude', timeout: 10 },
    { code: 0, stdout: JSON.stringify({ decision: 'force_ask', reason: 'Confirm delete' }), stderr: '' },
  );
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'force_ask', reason: 'Confirm delete' });

  const resSpecific = translateResult(
    { event: 'PreToolUse', dialect: 'claude', timeout: 10 },
    { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'force_ask', permissionDecisionReason: 'Confirm' } }), stderr: '' },
  );
  assert.deepEqual(JSON.parse(resSpecific.stdout), { decision: 'force_ask', reason: 'Confirm' });

  const unwrapped = toSourceTool({
    name: 'call_mcp_tool',
    args: { ServerName: 'zoho', ToolName: 'delete_task', Arguments: { id: '42' } },
  }, 'claude');
  assert.equal(unwrapped.tool_name, 'mcp__zoho__delete_task');
  assert.deepEqual(unwrapped.tool_input, { id: '42' });

  const unwrappedJsonStr = toSourceTool({
    name: 'mcp_tool',
    args: { server_name: 'slack', tool_name: 'post_msg', arguments: '{"channel":"general"}' },
  }, 'claude');
  assert.equal(unwrappedJsonStr.tool_name, 'mcp__slack__post_msg');
  assert.deepEqual(unwrappedJsonStr.tool_input, { channel: 'general' });
});

test('resolveHookSpawn uses Git bash on win32 for .sh scripts, shebang scripts and POSIX subshells', () => {
  const prev = process.env.AGY_GIT_BASH;
  process.env.AGY_GIT_BASH = process.execPath;
  const dir = tempDir('porter-shebang-');
  writeFileSync(join(dir, 'session-start'), '#!/usr/bin/env bash\necho ok\n');
  try {
    const spec = resolveHookSpawn('bash "C:/p/hooks/check.sh"', 'win32');
    assert.equal(spec.file, process.execPath);
    assert.deepEqual(spec.args, ['-c', 'bash "C:/p/hooks/check.sh"']);
    assert.equal(spec.shell, false);

    const shebangSpec = resolveHookSpawn(`"${join(dir, 'session-start').replace(/\\/g, '/')}"`, 'win32', dir);
    assert.equal(shebangSpec.file, process.execPath);
    assert.equal(shebangSpec.shell, false);

    const nodeSpec = resolveHookSpawn('node "C:/p/hooks/check.mjs"', 'win32');
    assert.equal(nodeSpec.shell, true);
  } finally {
    if (prev === undefined) delete process.env.AGY_GIT_BASH;
    else process.env.AGY_GIT_BASH = prev;
  }
});

test('shouldRun filters narrow MCP source matchers and PostToolUse failure state', () => {
  const entry = { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', matcher: 'mcp__zoho__delete_record' };
  assert.equal(shouldRun(entry, { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'zoho', ToolName: 'delete_record' } } }), true);
  assert.equal(shouldRun(entry, { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'github', ToolName: 'list_issues' } } }), false);

  const anchored = { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', matcher: '^mcp__[A-Za-z0-9._-]*exabeam[A-Za-z0-9._-]*__' };
  assert.equal(shouldRun(anchored, { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'my-exabeam-prod', ToolName: 'query' } } }), true);
  assert.equal(shouldRun(anchored, { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'slack', ToolName: 'post' } } }), false);
});

test('runCommand times out and terminates child trees cleanly', async () => {
  const res = await runCommand(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, {
    cwd: process.cwd(),
    env: process.env,
    input: '{}',
    timeoutMs: 120,
  });
  assert.equal(res.timedOut, true);
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
  const dir = join(tempDir('porter-shim-'), 'plugin root');
  mkdirSync(dir);
  cpSync(fixture('claude'), dir, { recursive: true });
  writeHookPort(dir, compileHooks(detect(dir).hookSources, { slug: 'fixture-claude' }));
  return dir;
}
function runShim(dir, event, hook, payload) {
  const temp = tempDir('porter-shim-tmp-');
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

test('PORTER-01: toSourcePayload maps eager mcp_<server>_<tool> back to mcp__<server>__<tool>', () => {
  const entry = { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', matcher: 'mcp__zoho__delete_record' };
  const rawPayload = {
    toolCall: {
      name: 'mcp_zoho_delete_record',
      args: { record_id: '42' },
    },
  };
  const payload = toSourcePayload(entry, rawPayload);
  assert.equal(payload.tool_name, 'mcp__zoho__delete_record');
  assert.deepEqual(payload.tool_input, { record_id: '42' });
  assert.equal(shouldRun(entry, rawPayload), true);

  // Server name containing underscore resolved via entry.matcher
  const multiUnderscoreEntry = { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', matcher: 'mcp__my_server__delete_record' };
  const multiRawPayload = {
    toolCall: {
      name: 'mcp_my_server_delete_record',
      args: { id: '7' },
    },
  };
  const multiPayload = toSourcePayload(multiUnderscoreEntry, multiRawPayload);
  assert.equal(multiPayload.tool_name, 'mcp__my_server__delete_record');
  assert.deepEqual(multiPayload.tool_input, { id: '7' });
  assert.equal(shouldRun(multiUnderscoreEntry, multiRawPayload), true);
});

test('PORTER-02: shouldRun handles anchored alternations, parens, prefixes, and ignores generic call_mcp_tool rawToolName', () => {
  const mkEntry = (matcher) => ({ event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', matcher });
  const exabeamCall = { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'exabeam', ToolName: 'search_events', Arguments: {} } } };
  assert.equal(shouldRun(mkEntry('Bash|^mcp__exabeam__'), exabeamCall), true);
  assert.equal(shouldRun(mkEntry('(^mcp__exabeam__)'), exabeamCall), true);
  assert.equal(shouldRun(mkEntry('mcp__exabeam__'), exabeamCall), true);
  assert.equal(shouldRun(mkEntry('Bash|^mcp__exabeam__'), { toolCall: { name: 'Bash_extra', args: {} } }), false);
  // Generic rawToolName must not cause false-positive match on unrelated MCP tool
  const githubCall = { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'github', ToolName: 'create_issue', Arguments: {} } } };
  assert.equal(shouldRun(mkEntry('call_mcp_tool|mcp__zoho__delete_record'), githubCall), false);
});

test('PORTER-03: translateResult preserves call_mcp_tool ServerName/ToolName envelope when hook returns updatedInput', () => {
  const entry = {
    event: 'PreToolUse',
    dialect: 'claude',
    matcher: 'mcp__zoho__update_record',
    toolName: 'call_mcp_tool',
    toolArgs: {
      ServerName: 'zoho',
      ToolName: 'update_record',
      Arguments: { id: '1', status: 'draft' },
    },
  };
  const res = translateResult(entry, {
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { id: '1', status: 'approved' },
      },
    }),
    stderr: '',
  });
  assert.deepEqual(JSON.parse(res.stdout).overwrite, {
    ServerName: 'zoho',
    ToolName: 'update_record',
    Arguments: { id: '1', status: 'approved' },
  });

  // Also preserves stringified JSON Arguments when original Arguments was a JSON string
  const strEntry = {
    ...entry,
    toolArgs: {
      ServerName: 'zoho',
      ToolName: 'update_record',
      Arguments: JSON.stringify({ id: '1', status: 'draft' }),
    },
  };
  const strRes = translateResult(strEntry, {
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { id: '1', status: 'approved' },
      },
    }),
    stderr: '',
  });
  assert.deepEqual(JSON.parse(strRes.stdout).overwrite, {
    ServerName: 'zoho',
    ToolName: 'update_record',
    Arguments: JSON.stringify({ id: '1', status: 'approved' }),
  });
});

test('PORTER-04: expandCommand quotes paths with spaces and resolveHookSpawn handles #!/usr/bin/env node shebangs', () => {
  const rootWithSpaces = 'C:\\Users\\Jane Doe\\.gemini\\plugins\\my-plugin';
  const expanded = expandCommand('node ${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs --flag', { CLAUDE_PLUGIN_ROOT: rootWithSpaces }, { posix: true });
  assert.equal(expanded, 'node "C:/Users/Jane Doe/.gemini/plugins/my-plugin/scripts/guard.mjs" --flag');

  // Already-quoted token must not be double-quoted
  const alreadyQuoted = expandCommand('node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" --flag', { CLAUDE_PLUGIN_ROOT: rootWithSpaces }, { posix: true });
  assert.equal(alreadyQuoted, 'node "C:/Users/Jane Doe/.gemini/plugins/my-plugin/scripts/guard.mjs" --flag');

  // Script with #!/usr/bin/env node shebang in a directory with spaces
  const baseDir = tempDir('porter space dir ');
  mkdirSync(join(baseDir, 'scripts'), { recursive: true });
  const scriptPath = join(baseDir, 'shebang-hook.mjs');
  writeFileSync(scriptPath, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ decision: "deny", reason: "from-shebang" }));\n');
  // On Linux and macOS the shell runs the script itself, which needs the execute bit.
  chmodSync(scriptPath, 0o755);
  writeFileSync(join(baseDir, 'scripts/hook-shim.json'), JSON.stringify({
    hooks: {
      'pre-1': { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', command: '${CLAUDE_PLUGIN_ROOT}/shebang-hook.mjs' },
    },
  }));
  cpSync(join(fixture('claude'), '..', '..', '..', 'scripts', 'hook-shim.mjs'), join(baseDir, 'scripts/hook-shim.mjs'));
  const run = spawnSync(process.execPath, [join(baseDir, 'scripts/hook-shim.mjs'), '--event', 'PreToolUse', '--hook', 'pre-1'], {
    cwd: baseDir,
    input: JSON.stringify(livePre('echo test')),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout, `the shim printed nothing (it failed open): ${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout), { decision: 'deny', reason: 'from-shebang' });
});

// Node resolves symlinks in the main module's URL but not in argv[1]; macOS's
// tmpdir (/var -> /private/var) and a linked home both hit this.
test('the shim runs when its plugin is reached through a linked folder', () => {
  const real = tempDir('porter-linked-');
  mkdirSync(join(real, 'scripts'));
  writeFileSync(join(real, 'hook.mjs'), 'process.stdout.write(JSON.stringify({ decision: "deny", reason: "linked" }));\n');
  writeFileSync(join(real, 'scripts/hook-shim.json'), JSON.stringify({
    hooks: { 'pre-1': { event: 'PreToolUse', sourceEvent: 'PreToolUse', dialect: 'claude', command: 'node hook.mjs' } },
  }));
  cpSync(fileURLToPath(new URL('../scripts/hook-shim.mjs', import.meta.url)), join(real, 'scripts/hook-shim.mjs'));
  const link = removeLater(`${real}-link`);
  symlinkSync(real, link, 'junction');
  const run = spawnSync(process.execPath, [join(link, 'scripts/hook-shim.mjs'), '--event', 'PreToolUse', '--hook', 'pre-1'], {
    cwd: link,
    input: JSON.stringify(livePre('echo test')),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout, `the shim printed nothing: ${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout), { decision: 'deny', reason: 'linked' });
});

