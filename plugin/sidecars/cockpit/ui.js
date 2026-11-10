// The cockpit view: previews a port, shows its report, and installs it after the user
// confirms the tier and the audit findings in a consent bar. Built on sidecar-kit's
// native components (window.AgyUI), as Hangar and context-monitor are.
(() => {
  const ui = window.AgyUI;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => ui.escHtml(s ?? '');
  const token = new URLSearchParams(location.search).get('token') || '';
  const headers = { 'Content-Type': 'application/json', 'X-Sidecar-Token': token };
  const api = async (path, body) => {
    const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  };

  // The same tier colors as Hangar's badges
  const TIERS = {
    TIER_1_TELEMETRY: { short: 'Tier 1', label: 'Tier 1 (telemetry)', state: 'running' },
    TIER_2_LOCAL_TOOLING: { short: 'Tier 2', label: 'Tier 2 (local tooling)', state: 'hibernated' },
    TIER_3_AGENT_CONTROL: { short: 'Tier 3', label: 'Tier 3 (agent control)', state: 'errored' },
  };
  const SEVERITY = { high: 'errored', medium: 'hibernated', low: 'stopped' };
  const tierOf = (t) => TIERS[t] ?? { short: t, label: t, state: 'stopped' };
  const badge = (text, state, { icon = '', title = '' } = {}) =>
    `<span class="agy-badge ${esc(state)}"${title ? ` title="${esc(title)}"` : ''}>${icon ? ui.iconSvg(icon, 11) : ''}<span>${esc(text)}</span></span>`;
  const tierBadge = (t) => badge(tierOf(t).short, tierOf(t).state, { icon: 'shield', title: tierOf(t).label });
  let current = null;

  function status(text, tone = 'is-info') {
    const el = $('status');
    el.textContent = text;
    el.className = `agy-banner ${tone}${text ? '' : ' hidden'}`;
  }

  function busy(btn, label) {
    btn.disabled = Boolean(label);
    if (label) {
      btn.dataset.label ??= btn.textContent;
      btn.textContent = label;
    } else if (btn.dataset.label) {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
  }

  function section(title, items, render) {
    const body = items.length
      ? `<ul class="cockpit-list">${items.map((item) => `<li>${render(item)}</li>`).join('')}</ul>`
      : '<p class="cockpit-none">None.</p>';
    return `<div class="agy-card-section-bar"><span>${esc(title)}</span>${ui.renderCountPill(items.length)}</div>${body}`;
  }

  function validationBadge(v) {
    if (!v) return badge('Not validated', 'hibernated', { icon: 'warning', title: "agy isn't on PATH, so this port can't be installed" });
    return v.ok ? badge('Validated', 'running', { icon: 'check' })
      : badge(`Validation failed (${v.errors.length})`, 'errored', { icon: 'error' });
  }

  function showReport(p) {
    current = p;
    const r = p.report;
    const meta = [p.source, p.path && `path ${p.path}`, r.sourceCommit && `commit ${r.sourceCommit.slice(0, 12)}`].filter(Boolean).join(' · ');
    const box = $('report');
    box.innerHTML = `
      <div class="agy-card-header">
        <div class="cockpit-title-group">
          <div class="agy-card-title">${esc(p.slug)}</div>
          <div class="agy-card-meta">${esc(meta)}</div>
        </div>
        <div class="cockpit-badges">
          ${badge(r.ecosystems.join(' + ') || 'unknown', 'stopped', { icon: 'extension' })}${tierBadge(p.tier)}${validationBadge(r.validation)}
        </div>
      </div>
      ${section('Ported', r.ported, (x) => esc(x))}
      ${section('Not ported', r.unported, (u) => `<code>${esc(u.item)}</code> ${esc(u.reason)}`)}
      ${section('Warnings', r.warnings, (w) => esc(w))}
      ${section('Audit findings', r.flags, (f) => `${badge(f.severity, SEVERITY[f.severity] ?? 'stopped')} ${esc(f.kind)}${
        f.file ? ` <code>${esc(f.file)}${f.line ? `:${f.line}` : ''}</code>` : ''}`)}
      ${section('Why this tier', r.tierReasons, (x) => esc(x))}
      <div class="cockpit-actions">
        <button id="install" type="button" class="agy-btn agy-btn-primary"${r.validation?.ok ? '' : ' disabled'}>Install…</button>
      </div>
      <div id="consent" class="agy-consent-bar hidden">
        <span id="consent-text"></span>
        <div class="agy-consent-actions">
          <button id="cancel" type="button" class="agy-btn agy-btn-outline">Cancel</button>
          <button id="ok" type="button" class="agy-btn agy-btn-primary">Install</button>
        </div>
      </div>`;
    $('install').addEventListener('click', confirmInstall);
    $('cancel').addEventListener('click', () => {
      $('consent').classList.add('hidden');
      $('install').focus();
    });
    $('ok').addEventListener('click', install);
    box.hidden = false;
  }

  function confirmInstall() {
    const p = current;
    const flags = p.report.flags.length;
    const unported = p.report.unported.length;
    $('consent-text').innerHTML = `Install <strong>${esc(p.slug)}</strong> as ${esc(tierOf(p.tier).label)}, with `
      + `${unported} item${unported === 1 ? '' : 's'} not ported and ${flags} audit finding${flags === 1 ? '' : 's'}? `
      + 'You can switch it off later in Customizations > Plugins.';
    $('consent').classList.remove('hidden');
    $('cancel').focus();
  }

  async function install() {
    const p = current;
    $('consent').classList.add('hidden');
    busy($('install'), 'Installing…');
    status(`Installing ${p.slug}…`);
    try {
      const r = await api('/api/install', { previewId: p.id, acceptedTier: p.tier, acceptedFlags: p.flagsDigest });
      ui.showToast(`Installed ${r.slug}`);
      status(`Installed ${r.slug}. Switch it off in Customizations > Plugins before uninstalling it.`, 'is-success');
      $('report').hidden = true;
    } catch (err) {
      status(err.message, 'is-error');
    } finally {
      busy($('install'), '');
    }
    refresh();
  }

  async function refresh() {
    try {
      const { previews } = await api('/api/previews');
      $('recent-count').innerHTML = previews.length ? ui.renderCountPill(previews.length) : '';
      const list = $('recent');
      if (!previews.length) {
        list.innerHTML = ui.renderEmptyState({ icon: 'download', message: 'No previews yet. Preview a source to see its report here.' });
        return;
      }
      list.innerHTML = `<ul class="cockpit-list cockpit-rows">${previews.map((p) => `
        <li><button type="button" class="cockpit-row" data-id="${esc(p.id)}">
          <span class="cockpit-row-name">${esc(p.slug)}</span>
          <span class="cockpit-row-source">${esc(p.source)}</span>
          ${tierBadge(p.tier)}
        </button></li>`).join('')}</ul>`;
      for (const b of list.querySelectorAll('.cockpit-row')) {
        b.addEventListener('click', async () => {
          try {
            showReport(await api(`/api/preview?id=${encodeURIComponent(b.dataset.id)}`));
            status('');
          } catch (err) {
            status(err.message, 'is-error');
          }
        });
      }
    } catch (err) {
      status(err.message, 'is-error');
    }
  }

  $('fields').innerHTML = ui.renderField({
    id: 'source', label: 'Source', required: true, placeholder: 'owner/repo@v1.0.0', attrs: 'autocomplete="off" spellcheck="false"',
    help: 'A folder path, a GitHub link, or owner/repo@tag. Pin a tag or commit.',
  }) + '<div class="cockpit-row-2">' + ui.renderField({
    id: 'path', label: 'Path', placeholder: 'plugins/code-review', attrs: 'autocomplete="off" spellcheck="false"',
    help: 'Optional: the subfolder that holds the plugin.',
  }) + ui.renderField({
    id: 'slug', label: 'Name', placeholder: "Defaults to the plugin's own name", attrs: 'autocomplete="off" spellcheck="false"',
    help: "Optional: the plugin's name in Antigravity.",
  }) + '</div>';

  // A github.com link to a repo or folder becomes owner/repo@ref, with the folder in Path, so the fields show the form
  // they take. When Path already names a different folder, the link stays as it is and the porter reports the clash.
  // The porter accepts the link itself too (lib/source.mjs).
  const GITHUB_LINK = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)((?:\/[^/?#]*)*))?\/?(?:[?#].*)?$/i;
  function splitGithubLink() {
    const m = GITHUB_LINK.exec($('source').value.trim());
    if (!m) return;
    let owner, repo, ref, folder;
    try {
      [owner, repo, ref] = [m[1], m[2], m[3] ?? ''].map(decodeURIComponent);
      folder = (m[4] ?? '').split('/').filter(Boolean).map(decodeURIComponent).join('/');
    } catch {
      return;
    }
    const given = $('path').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (folder && given && given !== folder) return;
    $('source').value = `${owner}/${repo}${ref ? `@${ref}` : ''}`;
    if (folder) $('path').value = folder;
  }
  $('source').addEventListener('change', splitGithubLink);
  $('source').addEventListener('paste', () => setTimeout(splitGithubLink, 0));

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    splitGithubLink();
    const btn = $('preview');
    busy(btn, 'Previewing…');
    $('report').hidden = true;
    status('Porting… a GitHub source can take a minute.');
    try {
      showReport(await api('/api/preview', { source: $('source').value, path: $('path').value, slug: $('slug').value }));
      status('');
    } catch (err) {
      status(err.message, 'is-error');
    } finally {
      busy(btn, '');
      refresh();
    }
  });
  refresh();
})();
