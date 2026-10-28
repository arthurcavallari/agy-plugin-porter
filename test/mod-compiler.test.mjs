import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileHooks, writeHookPort } from '../lib/hook-compiler.mjs';
import { detect } from '../lib/detector.mjs';
import { compileMods, modHooks } from '../lib/mod-compiler.mjs';
import { inferTier } from '../lib/static-auditor.mjs';
import { compileSource, fixture, hasEsbuild, tempDir } from './mod-helpers.mjs';

const json = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const tsx = { skip: !hasEsbuild && 'esbuild not installed' };

test('fixture: compiles into a sidecar with forwarding hooks, tier 3', tsx, () => {
  const { pluginDir, report } = compileSource(fixture('claude-mod'));
  assert.deepEqual(report.unported, []);
  assert.deepEqual(report.ported, ['ui-mod:hooks/register.tsx (clean, sidecar pane, sidecar://fixture-claude-mod/pane/ui.html)']);
  for (const f of ['server.mjs', 'engine.mjs', 'instance.mjs', 'hook.mjs', 'mcp-entry.mjs', 'ui.html', 'ui.js', 'sidecar.json', 'mod/hooks/register.mjs']) {
    assert.ok(existsSync(join(pluginDir, 'sidecars/pane', f)), f);
  }
  const mod = json(pluginDir, 'sidecars/pane/mod.json');
  assert.equal(mod.entry, 'mod/hooks/register.mjs');
  assert.equal(mod.pluginName, 'fixture-claude-mod');
  assert.deepEqual(mod.allow, ['plugin.name', 'state.get', 'state.set', 'ui.open', 'ui.resolve', 'ui.status']);
  assert.equal(json(pluginDir, 'sidecars/pane/sidecar.json').ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  const hooks = json(pluginDir, 'hooks.json')['fixture-claude-mod-mod-pane'];
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
  assert.equal(hooks.PreToolUse[0].matcher, 'run_command');
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'agy-node sidecars/pane/hook.mjs PreToolUse');
  // No commands or tools, so no MCP server and no skills.
  assert.equal(existsSync(join(pluginDir, 'mcp_config.json')), false);
  const code = readFileSync(join(pluginDir, 'sidecars/pane/mod/hooks/register.mjs'), 'utf8');
  assert.match(code, /from "\.\.\/\.\.\/claude-code\.mjs"/);
  assert.doesNotMatch(code, /import type|DeniedCount/);
  assert.deepEqual(inferTier(pluginDir).tier, 'TIER_3_AGENT_CONTROL');
});

test('negative fixture: a transcript-only mod is refused and nothing is emitted', () => {
  const { pluginDir, report } = compileSource(fixture('claude-mod-transcript'));
  assert.deepEqual(report.ported, []);
  assert.deepEqual(report.unported, [{
    item: 'ui-mod:hooks/register.js',
    reason: 'not ported: it draws only into transcript sites (AssistantMessage), which Antigravity has no equivalent for',
  }]);
  assert.equal(existsSync(join(pluginDir, 'sidecars')), false);
  assert.equal(existsSync(join(pluginDir, 'hooks.json')), false);
});

test('without esbuild a TSX mod stays unported', () => {
  const { pluginDir, report } = compileSource(fixture('claude-mod'), { esbuild: null });
  assert.deepEqual(report.unported, [{ item: 'ui-mod:hooks/register.tsx', reason: 'needs esbuild to transform TS/TSX: port it with `npx agy-plugin-porter`, which installs esbuild as an optional dependency' }]);
  assert.equal(existsSync(join(pluginDir, 'sidecars')), false);
});

test('hybrid hooks file: classic hooks keep their shim, the mod gets its own group', () => {
  const src = tempDir('porter-hybrid-src-');
  cpSync(fixture('claude-mod-transcript'), src, { recursive: true });
  writeFileSync(join(src, 'hooks/register.js'), "export function register(on) {\n  on('turn.complete', async ($, e, next) => { await $.ui.toast('done'); return next(e) })\n  on('ui.render', { component: 'Pane' }, async ($, e) => null)\n}\n");
  writeFileSync(join(src, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } }));
  const detection = detect(src);
  const pluginDir = tempDir('porter-hybrid-out-');
  const hooks = compileHooks(detection.hookSources, { slug: 'hybrid' });
  assert.deepEqual(hooks.report.unported, []);
  writeHookPort(pluginDir, hooks);
  const report = compileMods(detection.uiMods, { srcDir: src, pluginDir, slug: 'hybrid', sourceName: 'fixture-claude-mod-transcript' });
  assert.deepEqual(report.unported, []);
  const all = json(pluginDir, 'hooks.json');
  assert.deepEqual(Object.keys(all), ['hybrid', 'hybrid-mod-pane']);
  assert.match(all.hybrid.PreToolUse[0].hooks[0].command, /hook-shim\.mjs/);
  assert.deepEqual(Object.keys(all['hybrid-mod-pane']), ['SessionStart', 'Stop']);
});

test('commands and tools: an MCP server named after the source, one skill per command', () => {
  const src = tempDir('porter-cmd-src-');
  cpSync(fixture('claude-mod-transcript'), src, { recursive: true });
  writeFileSync(join(src, 'hooks/register.js'), [
    "const NAME = 'notes'",
    'export function register(on) {',
    "  on('session.start', async ($, e, next) => { await $.command.register({ name: NAME, description: 'Show notes.', argumentHint: '[text]' }); await $.tool.register({ name: 'add', description: 'Add a note.' }); return next(e) })",
    "  on('tool.call', { tool: 'mcp__fixture-claude-mod-transcript__add' }, async ($, e) => ({ result: 'ok' }))",
    "  on('ui.render', { component: 'Pane' }, async () => null)",
    '}',
  ].join('\n'));
  const { pluginDir, report } = compileSource(src, { slug: 'notes-port' });
  assert.ok(report.ported.includes('mcp:fixture-claude-mod-transcript') && report.ported.includes('command:/notes'), report.ported.join(', '));
  assert.deepEqual(json(pluginDir, 'mcp_config.json').mcpServers['fixture-claude-mod-transcript'], {
    command: 'agy-node', args: ['${PLUGIN_ROOT}/sidecars/pane/mcp-entry.mjs'],
  });
  const skill = readFileSync(join(pluginDir, 'skills/notes/SKILL.md'), 'utf8');
  assert.match(skill, /^name: notes$/m);
  assert.match(skill, /slash_notes/);
  assert.match(skill, /sidecar:\/\/notes-port\/pane\/ui\.html/);
  // The mod's own mcp__ tool never becomes an agy tool hook.
  assert.equal(json(pluginDir, 'hooks.json')['notes-port-mod-pane'].PreToolUse, undefined);
  assert.deepEqual(json(pluginDir, 'sidecars/pane/mod.json').tools, [{ name: 'add', description: 'Add a note.' }]);
});

test('modHooks: unmapped tools are reported, a matcher-less tool.call hooks every tool', () => {
  const scan = { events: [{ event: 'tool.call', matcher: { tool: 'TodoWrite' } }, { event: 'turn.start', matcher: {} }] };
  assert.deepEqual(modHooks(scan, 'pane').unmapped, ['TodoWrite']);
  assert.deepEqual(Object.keys(modHooks(scan, 'pane').events), ['SessionStart', 'PreInvocation', 'Stop']);
  const any = modHooks({ events: [{ event: 'tool.call', matcher: {} }] }, 'pane').events;
  assert.equal(any.PreToolUse[0].matcher, '*');
});
