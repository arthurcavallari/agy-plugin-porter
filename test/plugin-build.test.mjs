// The porter's own plugin: what the build writes, and that agy accepts it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditPlugin } from '../lib/static-auditor.mjs';
import { buildPlugin, COPIED } from '../scripts/build-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? files(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const json = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const hasAgy = spawnSync('agy', ['--version'], { encoding: 'utf8' }).status === 0;

test('build: plugin/ plus copies of lib/, bin/ and the runtime; 7-key manifest at the package version', () => {
  const { dir, version, tier } = buildPlugin({ outRoot: mkdtempSync(join(tmpdir(), 'porter-build-')), tar: false });
  const written = files(dir);
  for (const f of ['plugin.json', 'hooks.json', 'mcp_config.json', 'rules/AGENTS.md', 'skills/port-plugin/SKILL.md',
    'agents/plugin-migration-engineer.md', 'scripts/session-start.mjs', 'mcp/server.mjs', 'sidecars/cockpit/sidecar.json',
    'sidecars/cockpit/server.mjs', 'sidecars/cockpit/ui.html', 'lib/consent.mjs', 'bin/agy-porter.mjs',
    'scripts/hook-shim.mjs', 'scripts/mod-runtime/lifecycle.mjs', 'LICENSE']) {
    assert.ok(written.includes(f), `${f} missing`);
  }
  assert.equal(version, pkg.version);
  const manifest = json(dir, 'plugin.json');
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(Object.keys(manifest).filter((k) => !['name', 'displayName', 'description', 'version', 'logo', 'suggestedPrompts', 'disabled'].includes(k)), []);
  assert.ok(manifest.suggestedPrompts.length <= 3);
  assert.deepEqual(json(dir, 'hooks.json'), { 'agy-plugin-porter': { SessionStart: [{ type: 'command', command: 'agy-node scripts/session-start.mjs', timeout: 10 }] } });
  assert.deepEqual(json(dir, 'mcp_config.json').mcpServers.cli, { command: 'agy-node', args: ['${PLUGIN_ROOT}/mcp/server.mjs'] });
  for (const rel of COPIED.filter((r) => r !== 'LICENSE')) {
    const src = rel.endsWith('.mjs') ? [''] : files(join(ROOT, rel));
    for (const f of src) assert.equal(readFileSync(join(dir, rel, f), 'utf8'), readFileSync(join(ROOT, rel, f), 'utf8'), `${rel}/${f}`);
  }
  assert.deepEqual(auditPlugin(dir).flags, []);
  assert.equal(tier, 'TIER_3_AGENT_CONTROL');
});

test('build: the tarball holds one top folder, with its sha256 beside it', () => {
  const outRoot = mkdtempSync(join(tmpdir(), 'porter-build-'));
  const { tarball, sha256 } = buildPlugin({ outRoot });
  const list = spawnSync('tar', ['-tzf', tarball.split(/[\\/]/).pop()], { cwd: outRoot, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(list.length > 20);
  assert.ok(list.every((p) => p.startsWith('agy-plugin-porter/')), list.find((p) => !p.startsWith('agy-plugin-porter/')));
  assert.equal(readFileSync(`${tarball}.sha256`, 'utf8'), `${sha256}  ${tarball.split(/[\\/]/).pop()}\n`);
});

test('agy plugin validate --strict accepts the built plugin', { skip: !hasAgy && 'agy not on PATH' }, () => {
  const { dir } = buildPlugin({ outRoot: mkdtempSync(join(tmpdir(), 'porter-build-')), tar: false });
  const home = mkdtempSync(join(tmpdir(), 'porter-home-'));
  const run = spawnSync('agy', ['plugin', 'validate', dir, '--json'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const { components, findings } = JSON.parse(run.stdout);
  assert.deepEqual(components, { agents: 1, hooks: 1, mcpServers: 1, rules: 1, sidecars: 1, skills: 1 });
  // agy-node is on PATH only inside the app (or with %APPDATA%\Antigravity\bin added).
  assert.deepEqual(findings.filter((f) => !/agy-node/.test(f.message)), []);
});
