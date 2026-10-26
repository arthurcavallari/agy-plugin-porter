import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detect } from '../lib/detector.mjs';
import { compileHooks, remapMatcher, writeHookPort } from '../lib/hook-compiler.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const compileFixture = (name, slug = `fixture-${name}`) => compileHooks(detect(fixture(name)).hookSources, { slug });
const items = (list) => list.map((u) => u.item);
const claudeSource = (hooks, extra = {}) => [{ path: 'hooks/hooks.json', dialect: 'claude', config: { hooks, ...extra } }];
const cmd = (command, extra = {}) => ({ hooks: [{ type: 'command', command, ...extra }] });

test('claude fixture: native named shape, remapped matchers, flat SessionStart', () => {
  const { hooks, shimConfig, report } = compileFixture('claude');
  const native = hooks['fixture-claude'];
  assert.deepEqual(Object.keys(hooks), ['fixture-claude']);
  assert.equal(native.PreToolUse[0].matcher, 'run_command');
  assert.equal(native.PostToolUse[0].matcher, 'edit_file|replace_file_content|write_file|write_to_file');
  assert.deepEqual(native.SessionStart, [{
    type: 'command', command: 'node scripts/hook-shim.mjs --event SessionStart --hook sessionstart-1', timeout: 65,
  }]);
  assert.deepEqual(native.PreToolUse[0].hooks, [{
    type: 'command', command: 'node scripts/hook-shim.mjs --event PreToolUse --hook pretooluse-1', timeout: 15,
  }]);
  assert.equal(shimConfig.hooks['pretooluse-1'].command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/bash-guard.mjs"');
  assert.equal(shimConfig.hooks['pretooluse-1'].timeout, 10);
  assert.deepEqual(items(report.unported), ['hook:UserPromptSubmit']);
  assert.equal(report.ported.length, 3);
});

test('emitted commands are cwd-relative, unquoted and variable-free', () => {
  const { hooks } = compileFixture('claude');
  const commands = JSON.stringify(hooks).match(/"command":"[^"]*"/g);
  assert.ok(commands.length > 0);
  for (const c of commands) {
    assert.match(c, /^"command":"node scripts\/hook-shim\.mjs --event \w+ --hook [a-z]+-\d+"$/);
  }
});

test('gemini fixture: BeforeTool -> PreToolUse, millisecond timeouts', () => {
  const { hooks, shimConfig } = compileFixture('gemini');
  const native = hooks['fixture-gemini'];
  assert.equal(native.PreToolUse[0].matcher, 'run_command');
  assert.equal(native.SessionStart.length, 1);
  assert.equal(shimConfig.hooks['pretooluse-1'].sourceEvent, 'BeforeTool');
  assert.equal(shimConfig.hooks['pretooluse-1'].dialect, 'gemini');

  const timed = compileHooks([{ path: 'hooks/hooks.json', dialect: 'gemini',
    config: { hooks: { BeforeTool: [{ matcher: 'run_shell_command', ...cmd('x', { timeout: 2500 }) }] } } }], { slug: 'g' });
  assert.equal(timed.shimConfig.hooks['pretooluse-1'].timeout, 3);
});

test('claude-mod fixture: modules are left to the mod compiler, nothing compiled here', () => {
  const { hooks, shimConfig, report } = compileFixture('claude-mod');
  assert.equal(hooks, null);
  assert.equal(shimConfig, null);
  assert.deepEqual(report, { ported: [], unported: [], warnings: [] });
});

test('modules plus hooks: the classic hooks compile', () => {
  const { hooks, report } = compileHooks(
    claudeSource({ PreToolUse: [{ matcher: 'Bash', ...cmd('node guard.mjs') }] }, { modules: ['./mods/a.tsx', 'b.ts'] }),
    { slug: 'mixed' });
  assert.equal(hooks.mixed.PreToolUse[0].matcher, 'run_command');
  assert.deepEqual(items(report.unported), []);
});

test('remapMatcher', () => {
  assert.deepEqual(remapMatcher(undefined), { matcher: '*', unmapped: [] });
  assert.deepEqual(remapMatcher('*'), { matcher: '*', unmapped: [] });
  assert.deepEqual(remapMatcher('Bash'), { matcher: 'run_command', unmapped: [] });
  assert.deepEqual(remapMatcher('Notebook.*'), { matcher: 'notebook_edit', unmapped: [] });
  assert.deepEqual(remapMatcher('TodoWrite|Bash'), { matcher: 'run_command', unmapped: ['TodoWrite'] });
  assert.deepEqual(remapMatcher('mcp__github__.*'), { matcher: null, unmapped: ['mcp__github__.*'] });
  assert.deepEqual(remapMatcher('run_command|view_file'), { matcher: 'run_command|view_file', unmapped: [] });
  assert.deepEqual(remapMatcher('Bash['), { matcher: null, unmapped: ['Bash['] });
  assert.deepEqual(remapMatcher('run_shell_command', 'gemini'), { matcher: 'run_command', unmapped: [] });
});

test('unmappable matchers and events are reported, never dropped', () => {
  const { hooks, report } = compileHooks(claudeSource({
    PreToolUse: [
      { matcher: 'mcp__github__create_issue', ...cmd('a') },
      { matcher: 'Bash|TodoWrite', ...cmd('b') },
    ],
    Notification: [cmd('c')],
    SubagentStop: [cmd('d')],
  }), { slug: 's' });
  assert.equal(hooks.s.PreToolUse.length, 1);
  assert.deepEqual(items(report.unported), [
    'hook:PreToolUse#0 (mcp__github__create_issue) matcher mcp__github__create_issue',
    'hook:PreToolUse#1 (Bash|TodoWrite) matcher TodoWrite',
    'hook:Notification',
    'hook:SubagentStop',
  ]);
});

test('SessionStart source matchers and non-command handlers', () => {
  const { hooks, report } = compileHooks(claudeSource({
    SessionStart: [{ matcher: 'resume', ...cmd('a') }, { matcher: 'startup|compact', ...cmd('b') }],
    Stop: [{ hooks: [{ type: 'prompt', prompt: 'are you done?' }] }],
  }), { slug: 's' });
  assert.equal(hooks.s.SessionStart.length, 1);
  assert.equal(hooks.s.Stop, undefined);
  assert.deepEqual(items(report.unported), ['hook:SessionStart#0 (resume)', 'hook:Stop#0.0']);
  assert.ok(report.warnings.some((w) => /compact have no agy equivalent/.test(w)));
});

test('parse errors and invalid slugs', () => {
  const { report } = compileHooks([{ path: 'hooks/hooks.json', dialect: 'claude', config: null, error: 'Unexpected token' }], { slug: 's' });
  assert.deepEqual(report.unported, [{ item: 'hooks:hooks/hooks.json', reason: "can't parse: Unexpected token" }]);
  assert.throws(() => compileHooks([], { slug: 'bad slug' }), /invalid slug/);
});

test('writeHookPort replaces the staged foreign hooks and ships the shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porter-write-'));
  cpSync(fixture('claude'), dir, { recursive: true });
  cpSync(join(dir, 'hooks/hooks.json'), join(dir, 'hooks.json'));
  writeHookPort(dir, compileHooks(detect(dir).hookSources, { slug: 'fixture-claude' }));
  assert.equal(existsSync(join(dir, 'hooks/hooks.json')), false);
  assert.ok(existsSync(join(dir, 'scripts/hook-shim.mjs')));
  const shimConfig = JSON.parse(readFileSync(join(dir, 'scripts/hook-shim.json'), 'utf8'));
  assert.equal(Object.keys(shimConfig.hooks).length, 3);
  assert.ok(JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'))['fixture-claude']);
});

test('writeHookPort drops a UI-mod hooks.json (the mod compiler writes its own) and refuses to clobber a foreign shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porter-write-'));
  cpSync(fixture('claude-mod'), dir, { recursive: true });
  cpSync(join(dir, 'hooks/hooks.json'), join(dir, 'hooks.json'));
  writeHookPort(dir, compileHooks(detect(dir).hookSources, { slug: 'm' }));
  assert.equal(existsSync(join(dir, 'hooks/hooks.json')), false);
  assert.equal(existsSync(join(dir, 'hooks.json')), false);

  const other = mkdtempSync(join(tmpdir(), 'porter-write-'));
  cpSync(fixture('claude'), other, { recursive: true });
  writeFileSync(join(other, 'scripts/hook-shim.mjs'), '// the plugin\'s own file\n');
  assert.throws(() => writeHookPort(other, compileHooks(detect(other).hookSources, { slug: 'c' })), /isn't the porter's shim/);
});

const agy = spawnSync('agy', ['--version'], { encoding: 'utf8' });
test('agy plugin validate --strict accepts the compiled hooks', { skip: agy.status !== 0 && 'agy not on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'porter-validate-'));
  const home = mkdtempSync(join(tmpdir(), 'porter-home-'));
  cpSync(fixture('claude/scripts'), join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'fixture-claude', version: '0.1.0', description: 'x' }));
  writeHookPort(dir, compileHooks(detect(fixture('claude')).hookSources, { slug: 'fixture-claude' }));
  const run = spawnSync('agy', ['plugin', 'validate', dir, '--strict', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
