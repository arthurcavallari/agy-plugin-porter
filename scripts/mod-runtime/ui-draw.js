// Draws a ported mod's element trees ($.ui.resolve's names) as DOM. Text from the mod
// is always set as text, never parsed as HTML; Markdown escapes before formatting.
(() => {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Minimal Markdown: headings, lists, code spans, bold, italics, links.
  function markdown(text) {
    const out = [];
    let list = null;
    for (const line of String(text).split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) {
        const tag = li[1] ? 'ol' : 'ul';
        if (list !== tag) { if (list) out.push(`</${list}>`); out.push(li[1] ? `<ol start="${Number(li[1])}">` : '<ul>'); list = tag; }
        out.push(`<li>${inline(li[2])}</li>`);
        continue;
      }
      if (list) { out.push(`</${list}>`); list = null; }
      if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`</${list}>`);
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = out.join('');
    return div;
  }

  const COLORS = ['cyan', 'green', 'red', 'yellow', 'magenta', 'blue', 'gray', 'grey', 'white', 'black'];
  const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+)$/i;
  const textOf = (n) => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''));
  const unit = (v) => `${Number(v) * 0.5}em`;
  const color = (c) => (COLORS.includes(c) ? `var(--${c === 'grey' || c === 'gray' ? 'dim' : c}, ${c})` : SAFE_COLOR.test(c) ? c : '');

  function draw(node, act, inText = false) {
    if (typeof node === 'string') return document.createTextNode(node);
    const p = node.props ?? {};
    const kids = (el, nested = inText) => { for (const c of node.children ?? []) el.appendChild(draw(c, act, nested)); return el; };
    switch (node.type) {
      case 'Box': {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.flexDirection = p.flexDirection === 'column' ? 'column' : 'row';
        if (p.flexWrap) el.style.flexWrap = String(p.flexWrap);
        for (const k of ['gap', 'columnGap', 'rowGap']) if (p[k] != null) el.style[k] = unit(p[k]);
        if (p.flexGrow != null) el.style.flexGrow = String(Number(p.flexGrow));
        if (p.alignItems) el.style.alignItems = String(p.alignItems);
        if (p.justifyContent) el.style.justifyContent = String(p.justifyContent);
        if (el.style.flexDirection === 'row') el.style.alignItems ||= 'baseline';
        return kids(el, false);
      }
      case 'Text': {
        const el = document.createElement('span');
        el.className = 'Text' + (String(p.wrap ?? '').startsWith('truncate') ? ' trunc' : '');
        if (!inText) el.style.display = 'block';
        if (p.bold) el.style.fontWeight = '600';
        if (p.italic) el.style.fontStyle = 'italic';
        if (p.underline) el.style.textDecoration = 'underline';
        if (p.strikethrough) el.style.textDecoration = 'line-through';
        if (p.dimColor) el.style.color = 'var(--dim)';
        if (typeof p.color === 'string') el.style.color = color(p.color);
        return kids(el, true);
      }
      case 'Button': {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'el' + (p.plain ? ' plain' : '') + (p.variant === 'primary' ? ' primary' : '') + (p.dimColor ? ' dim' : '');
        el.textContent = p.label ?? textOf(node);
        if (typeof p.hotkey === 'string') { el.title = `Hotkey: ${p.hotkey}`; el.dataset.hotkey = p.hotkey; }
        if (p.onPress?.$cb) el.onclick = () => act(p.onPress);
        return el;
      }
      case 'Input': {
        const form = document.createElement('form');
        form.className = 'input';
        const input = document.createElement('input');
        input.placeholder = p.placeholder ?? p.label ?? '';
        input.value = p.value ?? '';
        input.setAttribute('aria-label', p.label ?? p.placeholder ?? 'input');
        const btn = document.createElement('button');
        btn.className = 'el';
        btn.textContent = p.submitLabel ?? 'OK';
        form.append(input, btn);
        form.onsubmit = (e) => {
          e.preventDefault();
          const cb = p.onSubmit?.$cb ? p.onSubmit : p.onChange;
          if (cb?.$cb) act(cb, input.value);
          input.value = '';
        };
        return form;
      }
      case 'Select': {
        const sel = document.createElement('select');
        for (const o of p.options ?? []) sel.add(new Option(o.label ?? String(o.value), o.value));
        if (p.value !== undefined) sel.value = p.value;
        const cb = p.onChange ?? p.onSelect ?? p.onSubmit;
        if (cb?.$cb) sel.onchange = () => act(cb, sel.value);
        return sel;
      }
      case 'Code': {
        const pre = document.createElement('pre');
        pre.textContent = p.source ?? textOf(node);
        return pre;
      }
      case 'Markdown':
        return markdown(p.text ?? p.source ?? textOf(node));
      case 'Divider':
        return document.createElement('hr');
      default: {
        const el = document.createElement('div');
        el.dataset.type = String(node.type);
        el.title = `${node.type} isn't drawn by the Antigravity port`;
        return kids(el);
      }
    }
  }

  window.PorterDraw = { draw, markdown };
})();
