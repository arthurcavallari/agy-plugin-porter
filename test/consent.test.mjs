// Previews and consent: a preview ports into a temp folder, and an install takes it
// only with the preview's tier and audit-findings digest handed back.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPreview, flagsDigest, installPreview, listPreviews, previewsDir, readPreview } from '../lib/consent.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const STUB = fileURLToPath(new URL('./agy-stub.mjs', import.meta.url));
const log = () => readFileSync(process.env.AGY_STUB_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'porter-consent-'));
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) process.env[k] = tmp;
  process.env.AGY_PORTER_AGY = STUB;
  process.env.AGY_STUB_LOG = join(tmp, 'agy.log');
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
