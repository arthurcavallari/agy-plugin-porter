// Previews and consent: a preview ports into a private folder, and an install takes it
// only with the preview's tier and audit-findings digest handed back.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { agyCommand, createPreview, flagsDigest, installPreview, listPreviews, previewsDir, readPreview } from '../lib/consent.mjs';
import { resolveAgyExecutable } from '../lib/index.mjs';
import { tempDir } from './temp.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const STUB = fileURLToPath(new URL('./agy-stub.mjs', import.meta.url));
const log = () => readFileSync(process.env.AGY_STUB_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(() => {
  const tmp = tempDir('porter-consent-');
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) process.env[k] = tmp;
  process.env.AGY_PORTER_PREVIEWS_DIR = join(tmp, 'previews');
  process.env.AGY_PORTER_AGY = STUB;
  process.env.AGY_STUB_LOG = join(tmp, 'agy.log');
});

test('previews default to a per-user cache folder, outside the shared temp dir', () => {
  const override = process.env.AGY_PORTER_PREVIEWS_DIR;
  delete process.env.AGY_PORTER_PREVIEWS_DIR;
  try {
    const dir = previewsDir();
    const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || homedir() : process.env.XDG_CACHE_HOME || homedir();
    assert.ok(dir.startsWith(base), dir);
    assert.ok(!dir.startsWith(tmpdir()), dir);
  } finally {
    process.env.AGY_PORTER_PREVIEWS_DIR = override;
  }
});

test('flagsDigest matches Hangar\'s: empty without flags, order-independent', () => {
  assert.equal(flagsDigest([]), '');
  const a = { kind: 'pipe-to-shell', severity: 'high', file: 'x.sh', line: 3 };
  const b = { kind: 'entropy', severity: 'low', file: 'y.js' };
  assert.equal(flagsDigest([a, b]), flagsDigest([b, a]));
  assert.match(flagsDigest([a]), /^[a-f0-9]{16}$/);
});

test('a preview ports, validates with agy and lists; install needs the matching consent', async () => {
  const preview = await createPreview({ source: fixture('cursor'), slug: 'cursor-rules' });
  // Only the user can read or write a preview (POSIX; Windows has no mode bits).
  if (process.platform !== 'win32') assert.equal(statSync(join(previewsDir(), preview.id)).mode & 0o077, 0);
  assert.equal(preview.slug, 'cursor-rules');
  assert.equal(preview.tier, 'TIER_1_TELEMETRY');
  assert.equal(preview.validated, true);
  assert.equal(preview.report.validation.ok, true);
  assert.deepEqual(readPreview(preview.id), preview);
  assert.equal(listPreviews()[0].id, preview.id);

  await assert.rejects(installPreview({ previewId: preview.id, acceptedFlags: preview.flagsDigest }), /above the accepted none/);
  await assert.rejects(installPreview({ previewId: preview.id, acceptedTier: preview.tier, acceptedFlags: 'beef' }), /audit findings differ/);
  await assert.rejects(installPreview({ previewId: '../../etc', acceptedTier: preview.tier }), /no such preview/);

  const done = await installPreview({ previewId: preview.id, acceptedTier: 'TIER_2_LOCAL_TOOLING', acceptedFlags: preview.flagsDigest });
  assert.equal(done.slug, 'cursor-rules');
  const install = log().find((args) => args[1] === 'install');
  assert.equal(install[2], join(previewsDir(), preview.id, 'out'));
  assert.equal(readPreview(preview.id), null, 'an installed preview is removed');
});

test('expired previews are swept and refused; a bad source rejects with the porter\'s reason', async () => {
  const preview = await createPreview({ source: fixture('codex') });
  const file = join(previewsDir(), preview.id, 'preview.json');
  writeFileSync(file, JSON.stringify({ ...preview, createdAt: Date.now() - 2 * 60 * 60 * 1000 }));
  await assert.rejects(installPreview({ previewId: preview.id, acceptedTier: preview.tier, acceptedFlags: preview.flagsDigest }), /no such preview/);
  assert.ok(!listPreviews().some((p) => p.id === preview.id));
  await assert.rejects(createPreview({ source: 'not a path or repo' }), /neither an existing path nor owner\/repo/);
  await assert.rejects(createPreview({}), /source is required/);
});

test('without agy a preview still ports, but can\'t be installed', async () => {
  process.env.AGY_PORTER_AGY = join(tmpdir(), 'no-such-agy.mjs');
  try {
    const preview = await createPreview({ source: fixture('cursor') });
    assert.equal(preview.validated, false);
    await assert.rejects(installPreview({ previewId: preview.id, acceptedTier: preview.tier, acceptedFlags: preview.flagsDigest }), /agy isn't on PATH/);
  } finally {
    process.env.AGY_PORTER_AGY = STUB;
  }
});

test('agyCommand delegates to resolveAgyExecutable and honors AGY_PORTER_AGY or higher-semver ~/.gemini/bin/agy', () => {
  assert.equal(agyCommand(), STUB);
  assert.deepEqual(resolveAgyExecutable(STUB), {
    command: STUB,
    version: '1.5.13',
    supportsSandbox: true,
  });

  const saved = process.env.AGY_PORTER_AGY;
  delete process.env.AGY_PORTER_AGY;
  const homeDir = mkdtempSync(join(tmpdir(), 'porter-consent-home-'));
  const missingHome = mkdtempSync(join(tmpdir(), 'porter-consent-missing-'));
  try {
    const geminiBin = join(homeDir, '.gemini', 'bin', 'agy.exe');
    mkdirSync(join(homeDir, '.gemini', 'bin'), { recursive: true });
    writeFileSync(geminiBin, '');
    const chosen = agyCommand({
      homeDir,
      platform: 'win32',
      env: {},
      probe: (cmd) => ({ status: 0, stdout: cmd === geminiBin ? '1.5.13\n' : '1.5.4\n', stderr: '' }),
    });
    assert.equal(chosen, geminiBin);

    const probed = [];
    const fallback = agyCommand({
      homeDir: missingHome,
      platform: 'win32',
      env: {},
      probe: (cmd) => {
        probed.push(cmd);
        return { status: 0, stdout: '1.5.13\n', stderr: '' };
      },
    });
    assert.equal(fallback, 'agy');
    assert.deepEqual(probed, ['agy']);
  } finally {
    process.env.AGY_PORTER_AGY = saved;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(missingHome, { recursive: true, force: true });
  }
});
