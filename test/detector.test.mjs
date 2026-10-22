import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detect, isUiMod } from '../lib/detector.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('claude fixture: one classic hook config, no UI mod', () => {
  const found = detect(fixture('claude'));
  assert.deepEqual(found.ecosystems, ['claude']);
  assert.deepEqual(found.hookSources.map((s) => [s.path, s.dialect]), [['hooks/hooks.json', 'claude']]);
  assert.ok(found.hookSources[0].config.hooks.PreToolUse);
  assert.deepEqual(found.uiMods, []);
});

test('gemini fixture: gemini dialect hooks', () => {
  const found = detect(fixture('gemini'));
  assert.deepEqual(found.ecosystems, ['gemini']);
  assert.deepEqual(found.hookSources.map((s) => [s.path, s.dialect]), [['hooks/hooks.json', 'gemini']]);
});

test('claude-mod fixture: hooks.json with modules is flagged as a UI mod', () => {
  const found = detect(fixture('claude-mod'));
  assert.deepEqual(found.ecosystems, ['claude']);
  assert.deepEqual(found.uiMods, [{ path: 'hooks/hooks.json', modules: ['./register.tsx'], hasHooks: false }]);
});

test('native plugin dir is reported as antigravity', () => {
  assert.deepEqual(detect(fixture('agy-probe')).ecosystems, ['antigravity']);
});

test('manifest hooks: path and inline object are both found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porter-detect-'));
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config/extra-hooks.json'), JSON.stringify({ modules: ['./mod.ts'], hooks: { Stop: [] } }));
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', hooks: './config/extra-hooks.json' }));
  let found = detect(dir);
  assert.deepEqual(found.hookSources.map((s) => s.path), ['config/extra-hooks.json']);
  assert.deepEqual(found.uiMods, [{ path: 'config/extra-hooks.json', modules: ['./mod.ts'], hasHooks: true }]);

  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', hooks: { hooks: { Stop: [] } } }));
  found = detect(dir);
  assert.deepEqual(found.hookSources.map((s) => s.path), ['.claude-plugin/plugin.json#hooks']);
});

test('unparseable hooks.json is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porter-detect-'));
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'hooks'));
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), '{"name":"x"}');
  writeFileSync(join(dir, 'hooks/hooks.json'), '{ nope');
  const [source] = detect(dir).hookSources;
  assert.equal(source.config, null);
  assert.match(source.error, /JSON/);
});

test('isUiMod only matches a modules array', () => {
  assert.equal(isUiMod({ modules: ['./a.tsx'] }), true);
  assert.equal(isUiMod({ modules: './a.tsx' }), false);
  assert.equal(isUiMod({ hooks: {} }), false);
  assert.equal(isUiMod(null), false);
});
