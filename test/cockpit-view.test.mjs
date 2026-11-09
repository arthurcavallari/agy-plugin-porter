// The cockpit's view (ui.html + ui.js) in a DOM, on sidecar-kit's components, against a stubbed API:
// the kit fields render, a preview shows the report, and Install asks in a consent bar before posting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { attachAgyUI } from 'antigravity-sidecar-kit/ui';
import { parseHTML } from 'linkedom';

const COCKPIT = fileURLToPath(new URL('../plugin/sidecars/cockpit/', import.meta.url));
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

const PREVIEW = {
  id: 'p1', slug: 'review', source: 'acme/plugins@v1', path: 'plugins/review', tier: 'TIER_3_AGENT_CONTROL', flagsDigest: 'abc123',
  report: {
    ecosystems: ['claude'], sourceCommit: 'f'.repeat(40),
    ported: ['skill:review', 'agent:reviewer'], unported: [{ item: 'hook:UserPromptSubmit', reason: 'no agy event' }],
    warnings: [], flags: [{ severity: 'medium', kind: 'high-entropy', file: 'skills/review/SKILL.md', line: 3 }],
    tierReasons: ['agents: reviewer'], validation: { ok: true, errors: [] },
  },
};

function loadView({ preview = PREVIEW } = {}) {
  const html = readFileSync(`${COCKPIT}ui.html`, 'utf8');
  const { window: win, document: doc } = parseHTML(html);
  attachAgyUI(win);
  const calls = [];
  const fetchStub = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', body, token: init.headers?.['X-Sidecar-Token'] });
    const reply = path === '/api/previews' ? { busy: false, previews: calls.some((c) => c.path === '/api/preview') ? [preview] : [] }
      : path === '/api/preview' ? preview
        : path === '/api/install' ? { slug: preview.slug }
          : {};
    return { ok: true, status: 200, json: async () => reply };
  };
  const location = { search: '?token=t0k' };
  new Function('window', 'document', 'location', 'fetch', readFileSync(`${COCKPIT}ui.js`, 'utf8'))(win, doc, location, fetchStub);
  return { win, doc, calls, $: (id) => doc.getElementById(id) };
}

test('the form renders sidecar-kit fields, wired to their labels and help text', async () => {
  const { doc, $ } = loadView();
  await settle();
  for (const id of ['source', 'path', 'slug']) {
    const input = $(id);
    assert.ok(input.classList.contains('agy-input'), `${id} is an agy-input`);
    assert.equal(doc.querySelector(`label[for="${id}"]`).className, 'agy-field-label');
    assert.equal(input.getAttribute('aria-describedby'), `${id}-help`);
  }
  assert.equal($('source').hasAttribute('required'), true);
  assert.equal($('preview').className, 'agy-btn agy-btn-primary');
  assert.ok($('recent').querySelector('.agy-empty-state'), 'no previews yet shows an empty state');
});

test('a preview shows the report as kit badges and sections; Install asks first, then posts the consent', async () => {
  const { win, $, calls } = loadView();
  await settle();
  $('source').value = 'acme/plugins@v1';
  $('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await settle();

  const report = $('report');
  assert.equal(report.hidden, false);
  assert.equal(report.querySelector('.agy-card-title').textContent, 'review');
  const badges = [...report.querySelectorAll('.cockpit-badges .agy-badge')].map((b) => [b.textContent, b.classList.contains('errored') || b.classList.contains('running')]);
  assert.deepEqual(badges.map(([t]) => t), ['claude', 'Tier 3', 'Validated']);
  assert.ok(report.querySelector('.agy-badge.errored').textContent.includes('Tier 3'), 'Tier 3 uses the same color as in Hangar');
  const sections = [...report.querySelectorAll('.agy-card-section-bar')].map((s) => s.textContent.trim());
  assert.deepEqual(sections, ['Ported2', 'Not ported1', 'Warnings0', 'Audit findings1', 'Why this tier1']);
  assert.ok(report.querySelector('.agy-badge.hibernated'), 'a medium finding is a warning badge');
  assert.equal($('preview').disabled, false, 'the Preview button is usable again');
  assert.equal(calls.find((c) => c.path === '/api/preview').token, 't0k');

  // Install opens the consent bar; Cancel closes it without posting
  $('install').dispatchEvent(new win.Event('click'));
  assert.equal($('consent').classList.contains('hidden'), false);
  assert.match($('consent-text').textContent, /Install review as Tier 3 \(agent control\), with 1 item not ported and 1 audit finding\?/);
  $('cancel').dispatchEvent(new win.Event('click'));
  assert.equal($('consent').classList.contains('hidden'), true);
  assert.equal(calls.some((c) => c.path === '/api/install'), false);

  $('install').dispatchEvent(new win.Event('click'));
  $('ok').dispatchEvent(new win.Event('click'));
  await settle();
  const post = calls.find((c) => c.path === '/api/install');
  assert.deepEqual(post.body, { previewId: 'p1', acceptedTier: 'TIER_3_AGENT_CONTROL', acceptedFlags: 'abc123' });
  assert.ok($('status').classList.contains('is-success'));
  assert.match($('status').textContent, /Installed review/);
  assert.equal(report.hidden, true);
  assert.ok($('recent').querySelector('.cockpit-row'), 'the preview is listed under Recent previews');
});

test('an unvalidated port cannot be installed', async () => {
  const preview = { ...PREVIEW, report: { ...PREVIEW.report, validation: null } };
  const { win, $ } = loadView({ preview });
  await settle();
  $('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await settle();
  assert.equal($('install').disabled, true);
  assert.match($('report').querySelector('.cockpit-badges').textContent, /Not validated/);
});
