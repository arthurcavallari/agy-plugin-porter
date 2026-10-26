import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { blank, objectFields } from '../lib/mod-lexer.mjs';
import { assess, importsOf, scanMod } from '../lib/mod-scan.mjs';
import { fixture, SPIKE_MODS } from './mod-helpers.mjs';

const scanFiles = (dir) => scanMod(readdirSync(dir).filter((f) => /\.(m?js|tsx?)$/.test(f)).map((f) => ({ path: f, src: readFileSync(join(dir, f), 'utf8') })));
const events = (scan) => scan.events.map((e) => `${e.event}${Object.keys(e.matcher).length ? ` ${JSON.stringify(e.matcher)}` : ''}`);

test('lexer: comments, strings, templates and regexes are blanked, offsets kept', () => {
  const src = "const a = '$.x.y' // $.ui.open\n/* on('z') */ const r = /[)'$]/; const t = `a ${$.ui.toast('b')} c`;";
  const code = blank(src);
  assert.equal(code.length, src.length);
  assert.doesNotMatch(code, /\$\.x\.y|ui\.open|on\('z'\)/);
  assert.match(code, /\$\.ui\.toast\(' '\)/);
  const obj = "x({ name: ID, 'description': \"d, e\", argumentHint: `[a]`, nested: { name: 'no' }, other: f(1), short })";
  const fields = objectFields(blank(obj), obj, obj.indexOf('{'));
  assert.deepEqual(fields, { name: { ident: 'ID' }, description: { literal: 'd, e' }, argumentHint: { literal: '[a]' }, nested: { other: true }, other: { other: true }, short: { ident: 'short' } });
});

test('imports: runtime ones only, type-only ones dropped', () => {
  const src = "import { a } from './a.js'\nimport type { B } from 'claude-code'\nimport { atom } from 'claude-code'\nexport { c } from \"../c\"\nconst d = await import('./d.mjs')\n// import x from 'nope'";
  assert.deepEqual(importsOf(src), ['./a.js', 'claude-code', '../c', './d.mjs']);
});

test('fixture: pane, a Bash guard that denies, a status line; tier 3, clean', () => {
  const scan = scanMod([{ path: 'hooks/register.tsx', src: readFileSync(join(fixture('claude-mod'), 'hooks/register.tsx'), 'utf8') }]);
  assert.deepEqual(events(scan), ['session.start', 'tool.call {"tool":"Bash"}', 'ui.render {"component":"Pane","requestId":"porter-fixture"}']);
  assert.deepEqual([...scan.calls].sort(), ['plugin.name', 'state.get', 'state.set', 'ui.open', 'ui.resolve', 'ui.status']);
  assert.equal(scan.steersBuiltinTools, true);
  const a = assess(scan);
  assert.equal(a.verdict, 'clean');
  assert.equal(a.tier, 'TIER_3_AGENT_CONTROL');
  assert.deepEqual(a.findings, [{ item: '$.ui.open', level: 'fallback', reason: 'only the person can show the pane, through a sidecar:// link or its tab' }]);
});

test('task-board: constants resolve in the command and its matcher; clean, tier 2', () => {
  const scan = scanFiles(join(SPIKE_MODS, 'task-board', 'src'));
  assert.deepEqual(events(scan), ['session.start', 'command.run {"command":"task-board"}', 'ui.render {"component":"Pane"}']);
  assert.deepEqual(scan.commands, [{ name: 'task-board', description: 'Add tasks and toggle done status.', argumentHint: '[entry]' }]);
  assert.ok(scan.calls.has('store.keys') && scan.calls.has('clock.now'));
  const a = assess(scan);
  assert.equal(a.verdict, 'clean');
  assert.equal(a.tier, 'TIER_2_LOCAL_TOOLING');
});

test('replay-theater: observes Edit and Write without steering them; clean', () => {
  const scan = scanFiles(join(SPIKE_MODS, 'replay-theater', 'src'));
  assert.deepEqual(scan.events.filter((e) => e.event === 'tool.call').map((e) => e.matcher.tool), ['Edit', 'Write']);
  assert.deepEqual(scan.commands, [{ name: 'replay', description: "Step through the last turn's file edits" }]);
  assert.equal(scan.steersBuiltinTools, false);
  assert.equal(assess(scan).verdict, 'clean');
});

test('side-pane: its own tools, prompt.context and prompt.fill make it partial and tier 3', () => {
  const scan = scanFiles(join(SPIKE_MODS, 'side-pane', 'src'));
  assert.deepEqual(scan.tools.map((t) => t.name), ['update', 'clear']);
  assert.equal(scan.tools[1].description, 'Empty the side pane once nothing in it is open any more.');
  assert.deepEqual(scan.events.filter((e) => e.event === 'tool.call').map((e) => e.matcher.tool), ['mcp__side-pane__update', 'mcp__side-pane__clear']);
  const a = assess(scan);
  assert.equal(a.verdict, 'partial');
  assert.deepEqual(a.findings.filter((f) => f.level === 'partial').map((f) => f.item).sort(),
    ['$.prompt.fill', '$.ui.panes', 'event prompt.context', 'event tool.describe', 'event ui.close']);
  assert.deepEqual(a.tierReasons.slice(1), ['$.prompt.fill']);
});

test('refusals: transcript-only render sites and unloadable packages', () => {
  const src = readFileSync(join(fixture('claude-mod-transcript'), 'hooks/register.js'), 'utf8');
  const a = assess(scanMod([{ path: 'hooks/register.js', src }]));
  assert.equal(a.verdict, 'refused');
  assert.deepEqual(a.refusals, ['draws only into transcript sites (AssistantMessage), which Antigravity has no equivalent for']);
  const b = assess(scanMod([{ path: 'm.js', src: "import x from 'left-pad'\nexport function register(on) { on('ui.render', { component: 'Pane' }, () => null) }" }]));
  assert.match(b.refusals[0], /imports left-pad/);
});

test('unknown events and $ calls are reported, dynamic $ use warns', () => {
  const src = "export function register(on) { on('prompt.submit', async ($, e, next) => { await $.process.run(['ls']); const { ui } = $; return next(e) }) }";
  const a = assess(scanMod([{ path: 'm.js', src }]));
  assert.deepEqual(a.findings.map((f) => [f.item, f.level]), [['event prompt.submit', 'none'], ['$.process.run', 'none']]);
  assert.equal(a.tier, 'TIER_3_AGENT_CONTROL');
  assert.match(a.warnings.join('\n'), /accessed dynamically/);
});
