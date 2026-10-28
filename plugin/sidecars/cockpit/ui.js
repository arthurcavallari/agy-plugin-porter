// The cockpit view: previews a port, shows its report, and installs it after the user
// confirms the tier and the audit findings in a dialog.
(() => {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token') || '';
  const headers = { 'Content-Type': 'application/json', 'X-Sidecar-Token': token };
  const api = async (path, body) => {
    const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  };
  const TIER_TEXT = { TIER_1_TELEMETRY: 'Tier 1 (telemetry)', TIER_2_LOCAL_TOOLING: 'Tier 2 (local tooling)', TIER_3_AGENT_CONTROL: 'Tier 3 (agent control)' };
  let current = null;

  // Host theme: theme-change carries themeType (light/dark).
  window.addEventListener('message', (e) => {
    if (e.origin !== location.ancestorOrigins?.[0]) return;
    if (e.data?.type === 'theme-change') {
      const t = e.data.payload?.themeType ?? e.data.payload?.theme;
      if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    }
  });

  function status(text, error = false) {
    $('status').textContent = text;
    $('status').className = error ? 'error' : '';
  }

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function list(title, items, render) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', `${title} (${items.length})`));
    if (!items.length) return frag.append(el('p', 'None.', 'dim')), frag;
    const ul = el('ul');
    for (const item of items) ul.append(el('li', render(item)));
    frag.append(ul);
    return frag;
  }

  function showReport(p) {
    current = p;
    const r = p.report;
    const v = r.validation;
    const box = $('report');
    box.replaceChildren();
    box.append(el('h2', `${p.slug} (${r.ecosystems.join(' + ') || 'unknown'})`));
    box.append(el('p', `Source: ${p.source}${p.path ? `, path ${p.path}` : ''}${r.sourceCommit ? `, commit ${r.sourceCommit.slice(0, 12)}` : ''}`, 'dim'));
    box.append(el('p', TIER_TEXT[p.tier] ?? p.tier, 'tier'));
    if (r.tierReasons.length) box.append(el('p', `Because: ${r.tierReasons.join('; ')}`, 'dim'));
    box.append(list('Ported', r.ported, (x) => x));
    box.append(list('Not ported', r.unported, (u) => `${u.item}: ${u.reason}`));
    box.append(list('Warnings', r.warnings, (w) => w));
    box.append(list('Audit flags', r.flags, (f) => `[${f.severity}] ${f.kind}${f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`));
    const valid = v ? (v.ok ? ['agy plugin validate passed', 'ok'] : [`agy plugin validate failed (${v.errors.length} errors)`, 'bad'])
      : ['Not validated: agy isn\'t on PATH, so this port can\'t be installed', 'warn'];
    box.append(el('p', valid[0], valid[1]));
    const install = el('button', 'Install…');
    install.type = 'button';
    install.disabled = !v?.ok;
    install.addEventListener('click', confirmInstall);
    box.append(install);
    box.hidden = false;
  }

  function confirmInstall() {
    const p = current;
    $('confirm-title').textContent = `Install ${p.slug}?`;
    const flags = p.report.flags.length;
    $('confirm-body').textContent = `It will be installed into your Antigravity profile as ${TIER_TEXT[p.tier] ?? p.tier}, `
      + `with ${p.report.unported.length} item(s) not ported and ${flags} audit flag${flags === 1 ? '' : 's'}. `
      + 'You can switch it off later in Customizations > Plugins.';
    $('confirm').showModal();
  }

  async function install() {
    $('confirm').close();
    const p = current;
    status(`Installing ${p.slug}…`);
    try {
      const r = await api('/api/install', { previewId: p.id, acceptedTier: p.tier, acceptedFlags: p.flagsDigest });
      status(`Installed ${r.slug}. Switch it off in Customizations > Plugins before uninstalling it.`);
      $('report').hidden = true;
    } catch (err) {
      status(err.message, true);
    }
    refresh();
  }

  async function refresh() {
    try {
      const { previews } = await api('/api/previews');
      const ul = $('recent');
      ul.replaceChildren();
      for (const p of previews) {
        const li = el('li');
        const b = el('button', p.slug);
        b.type = 'button';
        b.addEventListener('click', async () => showReport(await api(`/api/preview?id=${encodeURIComponent(p.id)}`)));
        li.append(b, ` ${p.source} · ${TIER_TEXT[p.tier] ?? p.tier}`);
        ul.append(li);
      }
      $('recent-wrap').hidden = !previews.length;
    } catch (err) {
      status(err.message, true);
    }
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('preview').disabled = true;
    $('report').hidden = true;
    status('Porting… a GitHub source can take a minute.');
    try {
      showReport(await api('/api/preview', { source: $('source').value, path: $('path').value, slug: $('slug').value }));
      status('');
    } catch (err) {
      status(err.message, true);
    } finally {
      $('preview').disabled = false;
      refresh();
    }
  });
  $('ok').addEventListener('click', install);
  $('cancel').addEventListener('click', () => $('confirm').close());
  refresh();
})();
