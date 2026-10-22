#!/usr/bin/env node
/**
 * @fileoverview Packs the porter, installs the tarball into an empty project, and exercises
 * the published surface: the bin via npx, every exports subpath, the shipped file list, and
 * a real port of the Cursor fixture (which needs no agy). Unit tests import lib/ directly
 * and cannot catch packaging mistakes; this does.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'porter-pack-smoke-'));

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const [{ filename }] = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, ROOT));
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(`npm install --no-audit --no-fund "${join(work, filename)}"`, app);

  const installed = join(app, 'node_modules', pkg.name);
  assert.equal(existsSync(join(installed, 'test')), false, 'test/ must not be published');
  assert.equal(existsSync(join(installed, 'docs')), false, 'docs/ must not be published');
  for (const rel of ['LICENSE', 'README.md', 'scripts/hook-shim.mjs']) {
    assert.equal(existsSync(join(installed, rel)), true, `${rel} must be published`);
  }
  assert.equal(existsSync(join(installed, 'scripts/pack-smoke.mjs')), false, 'pack-smoke.mjs must not be published');

  for (const bin of Object.keys(pkg.bin)) {
    assert.match(run(`npm exec --no -- ${bin} --help`, app), /Usage: agy-porter/, `npx ${bin} --help`);
  }

  // A real port through the installed bin. Cursor sources need no agy.
  const out = join(work, 'out');
  const report = JSON.parse(run(`npm exec --no -- agy-porter --source "${join(ROOT, 'test/fixtures/cursor')}" --out "${out}" --json`, app));
  assert.equal(report.slug, 'cursor');
  assert.equal(existsSync(join(out, 'plugin.json')), true, 'ported plugin.json');
  assert.equal(existsSync(join(out, 'skills/react-components/SKILL.md')), true, 'ported glob rule as a skill');

  // Every exports subpath loads from the installed package
  const importable = Object.keys(pkg.exports).filter((subpath) => subpath !== './package.json');
  for (const subpath of importable) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    run(`node --input-type=module -e "await import('${specifier}')"`, app);
  }

  console.log(`[pack-smoke] ${filename}: bin, cursor port, and ${importable.length} exports OK`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
