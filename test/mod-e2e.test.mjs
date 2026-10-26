// End to end: bin/agy-porter.mjs ports the three stage mods straight from GitHub, at
// the commits pinned in spike/mods/*/port.json, and `agy plugin validate` accepts each.
// Opt-in (PORTER_E2E=1): it needs the network, agy on PATH and esbuild.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hasEsbuild, SPIKE_MODS, tempDir } from './mod-helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/agy-porter.mjs', import.meta.url));
const hasAgy = spawnSync('agy', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = process.env.PORTER_E2E !== '1' ? 'set PORTER_E2E=1 to run' : !hasAgy ? 'agy not on PATH' : !hasEsbuild && 'esbuild not installed';

const CASES = {
  'task-board': { verdict: 'clean', tier: 'TIER_2_LOCAL_TOOLING' },
  'replay-theater': { verdict: 'clean', tier: 'TIER_3_AGENT_CONTROL' }, // its Stop hook (see static-auditor)
  'side-pane': { verdict: 'partial', tier: 'TIER_3_AGENT_CONTROL' },
};

for (const [mod, expected] of Object.entries(CASES)) {
  test(`e2e ${mod}: ports from GitHub at its pinned commit and validates`, { skip, timeout: 300_000 }, () => {
    const port = JSON.parse(readFileSync(join(SPIKE_MODS, mod, 'port.json'), 'utf8'));
    const out = join(tempDir('porter-e2e-mod-'), 'out');
    const run = spawnSync(process.execPath, [BIN, '--source', `${port.source.repo}@${port.source.sha}`, '--path', port.source.path.replace(/\/hooks$/, ''),
      '--slug', `porter-test-${mod}`, '--out', out, '--validate', '--json'], { encoding: 'utf8', timeout: 280_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = JSON.parse(run.stdout);
    assert.equal(report.sourceCommit, port.source.sha);
    assert.deepEqual(report.unported, []);
    assert.ok(report.ported.some((p) => p.startsWith(`ui-mod:hooks/register.`) && p.includes(`(${expected.verdict}, sidecar pane`)), report.ported.join('\n'));
    assert.equal(report.tier, expected.tier);
    assert.equal(report.validation.ok, true, JSON.stringify(report.validation));
    assert.equal(report.validation.components?.sidecars, 1, JSON.stringify(report.validation.components));
    assert.equal(JSON.parse(readFileSync(join(out, 'sidecars/pane/mod.json'), 'utf8')).plugin, `porter-test-${mod}`);
  });
}
