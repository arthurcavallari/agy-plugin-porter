// The side-pane view of a ported Claude Code mod: draws the panes the sidecar sends
// over SSE, posts clicks back, and reports whether the person can see it.
(() => {
  const $ = (id) => document.getElementById(id);
  const { draw } = window.PorterDraw;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const raw = params.get('conversationId') || '';
  // A frame with no id, or _new, belongs to a conversation that doesn't exist yet (live).
  const conv = raw && raw !== '_new' ? raw : '';
  const headers = { 'Content-Type': 'application/json', 'X-Sidecar-Token': token };
  const post = (path, body) => fetch(path, { method: 'POST', headers, body: JSON.stringify({ conv, ...body }) }).then((r) => r.json());
  let state = { panes: [], strips: [], commands: [], status: null };
  let active = null;
  let viewId = null;

  // Host theme: theme-change carries themeType (light/dark).
  window.addEventListener('message', (e) => {
    if (e.origin !== location.ancestorOrigins?.[0]) return;
    if (e.data?.type === 'theme-change') {
      const t = e.data.payload?.themeType ?? e.data.payload?.theme;
      if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    }
  });

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
  const status = (text) => { $('status').textContent = text ?? ''; };
  const act = (cb, ...args) => post('/api/action', { cb: cb.$cb, args }).then((r) => { if (r.error) toast(r.error); });
  const note = (className, textContent) => Object.assign(document.createElement('div'), { className, textContent });

  // Hidden copies (another conversation's frame, Hangar's embedded views) must not
  // count as a placed pane: report visibilityState plus IntersectionObserver.
  let inViewport = false;
  let reported = null;
  function report() {
    const visible = document.visibilityState === 'visible' && inViewport;
    if (viewId === null || visible === reported) return;
    reported = visible;
    post('/api/visibility', { view: viewId, visible }).catch(() => {});
  }
  new IntersectionObserver((entries) => { inViewport = entries.at(-1).isIntersecting; report(); }).observe(document.documentElement);
  document.addEventListener('visibilitychange', report);

  // One button per command, with a labeled argument field; argumentHint is help text.
  function commandBar() {
    const bar = $('commands');
    bar.replaceChildren();
    (state.commands ?? []).forEach((c, i) => {
      const wrap = document.createElement('span');
      wrap.className = 'cmd';
      const btn = document.createElement('button');
      btn.className = 'el';
      btn.textContent = `/${c.name}`;
      btn.title = c.description ?? '';
      const input = document.createElement('input');
      input.id = `cmd-arg-${i}`;
      const label = Object.assign(document.createElement('label'), { htmlFor: input.id, textContent: 'Arguments' });
      wrap.append(btn, label, input);
      if (c.argumentHint) {
        const help = Object.assign(document.createElement('span'), { id: `cmd-help-${i}`, className: 'help', textContent: `/${c.name} ${c.argumentHint}` });
        input.setAttribute('aria-describedby', help.id);
        wrap.append(help);
      }
      const run = () => post('/api/command', { command: c.name, args: input.value }).then(() => { input.value = ''; });
      btn.onclick = run;
      input.onkeydown = (e) => { if (e.key === 'Enter') run(); };
      bar.appendChild(wrap);
    });
    bar.hidden = !(state.commands ?? []).length;
  }

  function renderAll() {
    commandBar();
    $('strips').replaceChildren(...(state.strips ?? []).map((s) => { const d = document.createElement('div'); d.appendChild(draw(s.tree, act)); return d; }));
    const panes = state.panes ?? [];
    if (!panes.some((p) => p.id === active)) active = panes.at(-1)?.id ?? null;
    const tabs = $('tabs');
    tabs.replaceChildren();
    for (const p of panes) {
      const b = document.createElement('button');
      b.className = p.id === active ? 'on' : '';
      b.textContent = p.title;
      b.onclick = () => { active = p.id; renderAll(); };
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = ' ×';
      x.title = 'Close this pane';
      x.onclick = (e) => { e.stopPropagation(); post('/api/close', { id: p.id }); };
      b.appendChild(x);
      tabs.appendChild(b);
    }
    tabs.hidden = panes.length === 0;
    const pane = panes.find((p) => p.id === active);
    const main = $('pane');
    if (!pane) return main.replaceChildren(note('empty', 'No pane is open. Use a command above, or ask the agent.'));
    if (pane.error) return main.replaceChildren(note('error', pane.error));
    main.replaceChildren(pane.tree ? draw(pane.tree, act) : note('empty', '(empty)'));
  }

  // Hotkeys of the active pane's buttons, when no field has focus.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) return;
    const btn = $('pane').querySelector(`button[data-hotkey="${CSS.escape(e.key)}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  });

  if (!conv) {
    $('pane').replaceChildren(note('empty', 'No conversation yet. Start one, then reopen this pane.'));
    return;
  }
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}&conv=${encodeURIComponent(conv)}`);
  events.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') { document.title = msg.mod; viewId = msg.view; reported = null; report(); }
    else if (msg.type === 'state') { state = msg; status(msg.status); renderAll(); }
    else if (msg.type === 'status') status(msg.text);
    else if (msg.type === 'toast') toast(msg.text);
    else if (msg.type === 'copy') toast((await copy(msg.text)) ? 'Copied.' : 'Could not copy.');
    else if (msg.type === 'fill') toast((await copy(msg.text)) ? 'Copied. Paste it into the prompt box.' : 'Could not copy the text for the prompt box.');
  };
  events.onerror = () => status('Disconnected from the sidecar. Retrying…');

  // The workspace is the conversation's cwd until a hook reports it.
  (async () => {
    try {
      const uris = await window.sidecar?.getWorkspaceUris?.();
      const first = Array.isArray(uris) ? uris[0] : null;
      const cwd = first ? decodeURIComponent(new URL(first).pathname).replace(/^\/([A-Za-z]:)/, '$1') : '';
      await post('/api/view', { cwd });
    } catch {}
  })();
})();
