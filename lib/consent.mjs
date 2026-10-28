// Previews and consent for installing a port into the user's Antigravity profile.
// A preview ports a source into a temp folder and records its report; an install
// takes only that folder, and only when the caller hands back the tier and the
// audit-findings digest the preview showed (the same rule as Hangar's installer).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS } from './static-auditor.mjs';
import { spawnAgy } from './transpiler-engine.mjs';

const BIN = fileURLToPath(new URL('../bin/agy-porter.mjs', import.meta.url));
const ID = /^[a-f0-9]{16}$/;
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

export const previewsDir = () => join(tmpdir(), 'agy-plugin-porter', 'previews');
export const agyCommand = () => process.env.AGY_PORTER_AGY || 'agy';
const hasAgy = (agy) => spawnAgy(agy, ['--version'], { encoding: 'utf8', timeout: 15_000 }).status === 0;

// Same digest as Hangar's flagsDigest (antigravity-sidecar-hub lib/plugin-installer.mjs),
// so consent given in one can be checked by the other.
export function flagsDigest(flags = []) {
  if (!flags.length) return '';
  const keys = flags.map((f) => [f.kind, f.severity, f.file || '', f.line || 0].join(':')).sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}

// Deletes previews older than the TTL. Returns the ones left, newest first.
export function listPreviews({ now = Date.now() } = {}) {
  const dir = previewsDir();
  if (!existsSync(dir)) return [];
  const kept = [];
  for (const id of readdirSync(dir)) {
    const preview = readPreview(id);
    if (!preview || now - preview.createdAt > PREVIEW_TTL_MS) rmSync(join(dir, id), { recursive: true, force: true });
    else kept.push(preview);
  }
  return kept.sort((a, b) => b.createdAt - a.createdAt);
}

export function readPreview(id) {
  if (!ID.test(String(id))) return null;
  try { return JSON.parse(readFileSync(join(previewsDir(), id, 'preview.json'), 'utf8')); } catch { return null; }
}

// Runs the porter's CLI in a child process, so the caller's event loop stays free.
function runPorter(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Ports `source` (a path or owner/repo@ref) into a fresh preview folder. Validates
// with agy when it's on PATH. Resolves to the preview record; rejects with the
// porter's error when the port fails.
export async function createPreview({ source, path, slug } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('source is required: a folder path or owner/repo@ref');
  listPreviews();
  const id = randomBytes(8).toString('hex');
  const dir = join(previewsDir(), id);
  const outDir = join(dir, 'out');
  mkdirSync(dir, { recursive: true });
  const agy = agyCommand();
  const validate = hasAgy(agy);
  const args = ['--source', source.trim(), '--out', outDir, '--json', '--agy', agy];
  if (path) args.push('--path', String(path));
  if (slug) args.push('--slug', String(slug));
  if (validate) args.push('--validate');
  const run = await runPorter(args);
  let report = null;
  try { report = JSON.parse(run.stdout); } catch {}
  if (!report) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error((run.stderr || run.stdout).trim().replace(/^agy-porter: /, '') || `the porter exited with ${run.code}`);
  }
  delete report.outDir;
  const preview = {
    id, createdAt: Date.now(), source: source.trim(), path: path || null, slug: report.slug,
    tier: report.tier, flagsDigest: flagsDigest(report.flags), validated: validate, report,
  };
  writeFileSync(join(dir, 'preview.json'), JSON.stringify(preview, null, 2));
  return preview;
}

// Installs a preview's output with `agy plugin install`, if the caller's consent
// covers it. Resolves to {slug, output}; rejects with the reason it refused.
export async function installPreview({ previewId, acceptedTier, acceptedFlags = '' } = {}) {
  const preview = readPreview(previewId);
  if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL_MS) throw new Error('no such preview (they expire after an hour): run a new preview');
  const accepted = TIERS.indexOf(acceptedTier);
  if (accepted < TIERS.indexOf(preview.tier)) throw new Error(`the port is ${preview.tier}, which is above the accepted ${acceptedTier || 'none'}`);
  if ((acceptedFlags || '') !== preview.flagsDigest) throw new Error('the accepted audit findings differ from this preview\'s: show the user the preview again');
  if (!preview.validated) throw new Error('this preview wasn\'t validated, because agy isn\'t on PATH; agy is needed to install');
  if (!preview.report.validation?.ok) throw new Error('the port failed `agy plugin validate`, so it can\'t be installed');
  const dir = join(previewsDir(), preview.id);
  const outDir = join(dir, 'out');
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) throw new Error('the preview\'s output is gone: run a new preview');
  const run = spawnAgy(agyCommand(), ['plugin', 'install', outDir], { encoding: 'utf8', timeout: 120_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.error || run.status !== 0) throw new Error(`agy plugin install failed: ${run.error?.message ?? output}`);
  rmSync(dir, { recursive: true, force: true });
  return { slug: preview.slug, output };
}
