#!/usr/bin/env node
// agy-porter --source <path|owner/repo@ref> [--path <dir>] [--slug <s>] [--out <dir>]
//            [--force] [--validate] [--install] [--json]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { portPackage } from '../lib/index.mjs';
import { spawnAgy } from '../lib/transpiler-engine.mjs';

const USAGE = `Usage: agy-porter --source <path|owner/repo@ref> [options]

Ports a Claude Code, Gemini CLI, Cursor, Roo/Kilo or Codex plugin into a native
Antigravity plugin and prints a port report.

Options:
  --source <spec>   local folder, or GitHub owner/repo[@tag|branch|sha]
  --path <dir>      subfolder of the source that holds the plugin
  --slug <name>     plugin name in Antigravity (default: the source's name)
  --out <dir>       where to write the ported plugin (required unless --install)
  --force           replace a non-empty --out
  --validate        run \`agy plugin validate\` on the output (throwaway home)
  --install         install the output with \`agy plugin install\` (your real profile)
  --agy <path>      agy executable (default: agy)
  --json            print the report as JSON
  -h, --help        show this help`;

function printReport(report) {
  const lines = [`agy-porter: ${report.slug} (${report.ecosystems.join(' + ')}), ${report.tier}`];
  if (report.sourceCommit) lines.push(`  source commit ${report.sourceCommit}`);
  lines.push(`  ported (${report.ported.length}):`, ...report.ported.map((p) => `    ✔ ${p}`));
  if (report.unported.length) lines.push(`  unported (${report.unported.length}):`, ...report.unported.map((u) => `    ✗ ${u.item}: ${u.reason}`));
  if (report.warnings.length) lines.push(`  warnings (${report.warnings.length}):`, ...report.warnings.map((w) => `    ⚠ ${w}`));
  if (report.flags.length) {
    lines.push(`  audit flags (${report.flags.length}):`,
      ...report.flags.map((f) => `    ! [${f.severity}] ${f.kind}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}${f.excerpt ? `  ${f.excerpt}` : ''}`));
  }
  if (report.tierReasons.length) lines.push(`  tier because: ${report.tierReasons.join('; ')}`);
  if (report.validation) {
    const v = report.validation;
    lines.push(`  agy plugin validate: ${v.ok ? 'passed' : 'FAILED'} (${v.errors.length} errors, ${v.warnings.length} warnings)`);
    for (const f of [...v.errors, ...v.warnings]) lines.push(`    ${f.severity === 'error' ? '✗' : '⚠'} ${f.file ?? ''}: ${f.message}`);
    if (v.output) lines.push(`    ${v.output}`);
  }
  console.log(lines.join('\n'));
}

async function main() {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      options: {
        source: { type: 'string' }, path: { type: 'string' }, slug: { type: 'string' }, out: { type: 'string' },
        force: { type: 'boolean' }, validate: { type: 'boolean' }, install: { type: 'boolean' },
        agy: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (!opts.source || (!opts.out && !opts.install)) { console.error(USAGE); return 1; }

  const outDir = opts.out ?? mkdtempSync(join(tmpdir(), 'agy-porter-out-'));
  try {
    const { report } = await portPackage({
      source: opts.source, path: opts.path, outDir, slug: opts.slug, agy: opts.agy, force: opts.force, validate: opts.validate,
    });
    if (opts.json) console.log(JSON.stringify({ outDir: opts.out ?? null, ...report }, null, 2));
    else {
      printReport(report);
      if (opts.out) console.log(`  written to ${outDir}`);
    }
    if (report.validation && !report.validation.ok) return 2;
    if (opts.install) {
      const run = spawnAgy(opts.agy ?? 'agy', ['plugin', 'install', outDir], { stdio: 'inherit' });
      if (run.status !== 0) return run.status ?? 1;
      console.log('Installed. Restart Antigravity to load a new plugin directory.');
    }
    return 0;
  } catch (err) {
    console.error(`agy-porter: ${err.message}`);
    return 1;
  } finally {
    if (!opts.out) rmSync(outDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
