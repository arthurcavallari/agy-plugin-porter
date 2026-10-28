#!/usr/bin/env node
// Builds the porter's own Antigravity plugin: plugin/ (skill, agent, rules, hook, MCP
// server, cockpit sidecar) plus copies of lib/, bin/ and the scripts lib/ needs, since a
// plugin installed with agy gets no npm install. Audits the result, then packs
// <out>/agy-plugin-porter-plugin-<version>.tgz (one top folder, as Hangar unpacks it)
// and its .sha256.
//   node scripts/build-plugin.mjs [--out <dir>] [--no-tar]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { auditPlugin } from '../lib/static-auditor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PLUGIN_NAME = 'agy-plugin-porter';
// Repo paths copied into the plugin as they are, next to plugin/'s own files.
export const COPIED = ['lib', 'bin', 'scripts/hook-shim.mjs', 'scripts/mod-runtime', 'LICENSE'];

export function buildPlugin({ outRoot = join(ROOT, 'dist', 'plugin'), tar = true } = {}) {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dir = join(resolve(outRoot), PLUGIN_NAME);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'plugin'), dir, { recursive: true });
  for (const rel of COPIED) cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

  const audit = auditPlugin(dir);
  if (audit.flags.length) {
    throw new Error(`the built plugin has audit flags:\n${audit.flags.map((f) => `  [${f.severity}] ${f.kind} ${f.file ?? ''}:${f.line ?? ''}`).join('\n')}`);
  }
  const result = { dir, version, tier: audit.tier, tarball: null, sha256: null };
  if (!tar) return result;

  // Relative paths from outRoot: GNU tar reads "C:\..." as a remote host.
  const name = `${PLUGIN_NAME}-plugin-${version}.tgz`;
  const run = spawnSync('tar', ['-czf', name, PLUGIN_NAME], { cwd: resolve(outRoot), encoding: 'utf8' });
  if (run.error || run.status !== 0) throw new Error(`tar failed: ${run.error?.message ?? run.stderr}`);
  result.tarball = join(resolve(outRoot), name);
  result.sha256 = createHash('sha256').update(readFileSync(result.tarball)).digest('hex');
  writeFileSync(`${result.tarball}.sha256`, `${result.sha256}  ${name}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'no-tar': { type: 'boolean' } } });
  try {
    const r = buildPlugin({ outRoot: values.out, tar: !values['no-tar'] });
    console.log(`[build-plugin] ${r.dir} (${r.version}, ${r.tier})`);
    if (r.tarball) console.log(`[build-plugin] ${r.tarball}\n[build-plugin] sha256 ${r.sha256}`);
  } catch (err) {
    console.error(`[build-plugin] ${err.message}`);
    process.exitCode = 1;
  }
}
