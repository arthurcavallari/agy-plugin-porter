// End to end: port every fixture, then check the output with `agy plugin
// validate` in a throwaway home. Claude/Gemini sources need agy for staging, so
// those tests (and all validation) skip when agy isn't on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { portPackage } from '../lib/index.mjs';
import { loadEsbuild } from '../lib/mod-transform.mjs';
import { transpile } from '../lib/transpiler-engine.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const hasAgy = spawnSync('agy', ['--version'], { encoding: 'utf8' }).status === 0;
const out = () => join(mkdtempSync(join(tmpdir(), 'porter-e2e-')), 'out');
const files = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? files(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();

const CASES = {
  claude: { agy: true, tier: 'TIER_3_AGENT_CONTROL', has: ['hooks.json', 'scripts/hook-shim.mjs', 'rules/AGENTS.md', 'agents/fixture-reviewer.md', 'mcp_config.json'], unported: ['hook:UserPromptSubmit'] },
  gemini: { agy: true, tier: 'TIER_2_LOCAL_TOOLING', has: ['hooks.json', 'rules/AGENTS.md', 'skills/hello/SKILL.md'], unported: ['gemini:excludeTools'] },
  'claude-mod': { agy: true, esbuild: true, tier: 'TIER_3_AGENT_CONTROL', has: ['hooks.json', 'sidecars/pane/sidecar.json', 'sidecars/pane/mod/hooks/register.mjs'], unported: [] },
  'claude-mod-transcript': { agy: true, tier: 'TIER_1_TELEMETRY', files: ['plugin.json'], unported: ['ui-mod:hooks/register.js'] },
  cursor: { tier: 'TIER_1_TELEMETRY', files: ['plugin.json', 'rules/always-style.md', 'rules/api-design.md', 'rules/cursorrules.md', 'skills/manual-only/SKILL.md', 'skills/react-components/SKILL.md'], unported: [] },
  roo: { tier: 'TIER_3_AGENT_CONTROL', files: ['agents/fixture-architect.md', 'agents/fixture-orchestrator.md', 'plugin.json', 'rules/roo-rules-style.md'], unported: ['mode:fixture-architect group edit (\\.md$)'] },
  codex: { tier: 'TIER_1_TELEMETRY', files: ['plugin.json', 'rules/AGENTS.md', 'skills/codex-skill/SKILL.md'], unported: [] },
  'agy-probe': { tier: 'TIER_2_LOCAL_TOOLING', has: ['plugin.json', 'hooks.json', 'scripts/probe.mjs'], unported: [] },
};

for (const [name, expected] of Object.entries(CASES)) {
  const skip = (expected.agy && !hasAgy && 'agy not on PATH') || (expected.esbuild && !loadEsbuild() && 'esbuild not installed');
  test(`fixture ${name}: ports and passes agy plugin validate`, { skip }, () => {
    const outDir = out();
    const report = transpile({ srcDir: fixture(name), outDir, validate: hasAgy });
    assert.equal(report.tier, expected.tier);
    assert.deepEqual(report.unported.map((u) => u.item), expected.unported);
    const written = files(outDir);
    if (expected.files) assert.deepEqual(written, expected.files);
    for (const f of expected.has ?? []) assert.ok(written.includes(f), `${f} missing from ${written.join(', ')}`);
    assert.ok(!written.some((f) => /^(\.claude-plugin|commands|hooks\/|CLAUDE\.md|GEMINI\.md|\.mcp\.json|gemini-extension\.json)/.test(f)), written.join(', '));
    if (hasAgy) assert.equal(report.validation.ok, true, JSON.stringify(report.validation));
    if (hasAgy && name !== 'agy-probe') assert.deepEqual(report.validation.errors.concat(report.validation.warnings), []);
  });
}

test('claude fixture output: MCP uses ${PLUGIN_ROOT}, agent is agy-shaped', { skip: !hasAgy && 'agy not on PATH' }, () => {
  const outDir = out();
  transpile({ srcDir: fixture('claude'), outDir });
  const mcp = readFileSync(join(outDir, 'mcp_config.json'), 'utf8');
  assert.match(mcp, /\$\{PLUGIN_ROOT\}\/scripts\/echo-mcp\.mjs/);
  assert.doesNotMatch(mcp, /CLAUDE_PLUGIN_ROOT|AppData|tmp/);
  assert.match(readFileSync(join(outDir, 'agents/fixture-reviewer.md'), 'utf8'), /tools:\n {2}- find_by_name[\s\S]*model: pro/);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'plugin.json'), 'utf8')), {
    name: 'fixture-claude', description: 'Claude Code fixture exercising every porter translation path.', version: '0.1.0',
  });
});

test('gemini fixture output: no absolute staging paths survive', { skip: !hasAgy && 'agy not on PATH' }, () => {
  const outDir = out();
  transpile({ srcDir: fixture('gemini'), outDir });
  const mcp = JSON.parse(readFileSync(join(outDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.memory.args[0].replace(/\\/g, '/'), '${PLUGIN_ROOT}/scripts/echo-mcp.mjs');
});

test('manifest-less Claude plugin (skills only) is staged with a stand-in manifest', { skip: !hasAgy && 'agy not on PATH' }, () => {
  const src = mkdtempSync(join(tmpdir(), 'porter-bare-'));
  const skill = join(src, 'skills', 'bare');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(skill)}, {recursive: true})`]);
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: bare\ndescription: d\n---\nbody\n');
  const outDir = out();
  const report = transpile({ srcDir: src, outDir, slug: 'bare-plugin', validate: true });
  assert.deepEqual(report.ecosystems, ['claude']);
  assert.ok(report.warnings.some((w) => /no \.claude-plugin\/plugin\.json/.test(w)));
  assert.deepEqual(files(outDir), ['plugin.json', 'skills/bare/SKILL.md']);
  assert.equal(report.validation.ok, true);
});

test('refuses a non-empty out dir unless forced; rejects bad slugs and empty sources', () => {
  const outDir = out();
  transpile({ srcDir: fixture('codex'), outDir });
  assert.throws(() => transpile({ srcDir: fixture('codex'), outDir }), /isn't empty/);
  transpile({ srcDir: fixture('codex'), outDir, force: true });
  assert.throws(() => transpile({ srcDir: fixture('codex'), outDir: out(), slug: 'Bad Slug' }), /invalid slug/);
  assert.throws(() => transpile({ srcDir: mkdtempSync(join(tmpdir(), 'porter-none-')), outDir: out() }), /no plugin found/);
});

test('portPackage returns {report, tier}', async () => {
  const outDir = out();
  const { report, tier } = await portPackage({ srcDir: fixture('cursor'), outDir, slug: 'cursor-rules' });
  assert.equal(tier, 'TIER_1_TELEMETRY');
  assert.equal(JSON.parse(readFileSync(join(outDir, 'plugin.json'), 'utf8')).name, 'cursor-rules');
  assert.equal(report.slug, 'cursor-rules');
});

test('CLI: --json report, usage errors', () => {
  const bin = fileURLToPath(new URL('../bin/agy-porter.mjs', import.meta.url));
  const outDir = out();
  const run = spawnSync(process.execPath, [bin, '--source', fixture('roo'), '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.slug, 'roo');
  assert.ok(existsSync(join(outDir, 'agents/fixture-architect.md')));
  const usage = spawnSync(process.execPath, [bin, '--source', fixture('roo')], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: agy-porter/);
  const missing = spawnSync(process.execPath, [bin, '--source', 'not a path or repo', '--out', out()], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /neither an existing path nor owner\/repo/);
});
