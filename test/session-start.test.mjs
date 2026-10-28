// The plugin's SessionStart detector, run from a built plugin the way agy runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPlugin } from '../scripts/build-plugin.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let plugin;
let state;

before(() => {
  ({ dir: plugin } = buildPlugin({ outRoot: mkdtempSync(join(tmpdir(), 'porter-build-')), tar: false }));
  state = mkdtempSync(join(tmpdir(), 'porter-state-'));
});

function run(input) {
  const r = spawnSync(process.execPath, ['scripts/session-start.mjs'], {
    cwd: plugin, input, encoding: 'utf8', env: { ...process.env, AGY_PORTER_STATE_DIR: state },
  });
  return { code: r.status, out: JSON.parse(r.stdout) };
}
const message = (out) => out.injectSteps?.[0]?.systemMessage?.systemMessage;

test('a workspace with a Claude plugin is named once, until what it holds changes', () => {
  const ws = mkdtempSync(join(tmpdir(), 'porter-ws-'));
  cpSync(fixture('claude'), ws, { recursive: true });
  const first = run(JSON.stringify({ workspacePaths: [pathToFileURL(ws).href] }));
  assert.equal(first.code, 0);
  assert.match(message(first.out), /a Claude Code plugin/);
  assert.match(message(first.out), /port-plugin skill/);
  assert.deepEqual(run(JSON.stringify({ workspacePaths: [ws] })).out, {});
  cpSync(fixture('cursor/.cursorrules'), join(ws, '.cursorrules'));
  assert.match(message(run(JSON.stringify({ workspacePaths: [ws] })).out), /Cursor rules/);
});

test('UI mods are counted; plain folders, missing paths and bad input give {} and exit 0', () => {
  const ws = mkdtempSync(join(tmpdir(), 'porter-ws-'));
  cpSync(fixture('claude-mod'), ws, { recursive: true });
  assert.match(message(run(JSON.stringify({ workspacePaths: [ws] })).out), /1 Claude Code UI mod\b/);
  const plain = mkdtempSync(join(tmpdir(), 'porter-ws-'));
  writeFileSync(join(plain, 'README.md'), '# nothing to port\n');
  for (const input of [JSON.stringify({ workspacePaths: [plain, join(plain, 'gone')] }), '{}', 'not json', '']) {
    const r = run(input);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, {});
  }
});
