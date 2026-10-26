// Option 2 of plan §5.8: a hand-written JSX pass (to classic h()/Fragment calls) before
// Node's module.stripTypeScriptTypes, which rejects JSX. Spike quality: it handles the
// JSX the stage mods use (elements, fragments, string/expression/boolean/spread attributes,
// text and expression children), and skips strings, templates, comments and regexes.
const ID = /[A-Za-z_$][\w$.-]*/y;
const REGEX_BEFORE = /(^|[(,=:[!&|?{};+\-*%~^]|\breturn|\btypeof|\bcase|=>)\s*$/;
const JSX_BEFORE = /(^|[(,=:[?{}&|]|\breturn|=>)\s*$/;

const isJsxStart = (src, i) => src[i] === '<' && /[A-Za-z>]/.test(src[i + 1] ?? '') && JSX_BEFORE.test(src.slice(Math.max(0, i - 12), i));

function skipString(src, i) {
  const q = src[i];
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') { i = skipBraces(src, i + 1) - 1; continue; }
    if (src[i] === q) return i + 1;
  }
  throw new Error('unterminated string');
}

function skipRegex(src, i) {
  let inClass = false;
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) { i++; while (/[a-z]/i.test(src[i] ?? '')) i++; return i; }
  }
  throw new Error('unterminated regex');
}

// Returns the index just past the `}` that closes the `{` at i.
function skipBraces(src, i) {
  let depth = 0;
  for (; i < src.length;) {
    const c = src[i];
    if (c === '{') { depth++; i++; } else if (c === '}') { depth--; i++; if (depth === 0) return i; } else i = skipToken(src, i);
  }
  throw new Error('unbalanced braces');
}

function skipToken(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') return skipString(src, i);
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n < 0 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2;
  if (isJsxStart(src, i)) return parseElement(src, i).end;
  if (c === '/' && REGEX_BEFORE.test(src.slice(Math.max(0, i - 12), i))) return skipRegex(src, i);
  return i + 1;
}

// JSX text -> a string literal, with React's whitespace rules, or null if empty.
function jsxText(raw) {
  const lines = raw.split(/\r?\n/);
  const kept = lines.map((l, k) => {
    let s = l;
    if (k > 0) s = s.trimStart();
    if (k < lines.length - 1) s = s.trimEnd();
    return s;
  }).filter((s, k) => s !== '' || lines.length === 1);
  const text = kept.join(' ');
  return text === '' ? null : JSON.stringify(text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

function parseElement(src, i) {
  i++; // <
  const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
  ws();
  let name = 'Fragment';
  if (src[i] !== '>') { ID.lastIndex = i; const m = ID.exec(src); name = m[0]; i = ID.lastIndex; }
  const props = [];
  for (;;) {
    ws();
    if (src[i] === '/' && src[i + 1] === '>') return { code: `h(${name}, ${props.length ? `{ ${props.join(', ')} }` : 'null'})`, end: i + 2 };
    if (src[i] === '>') { i++; break; }
    if (src[i] === '{') { // {...spread}
      const end = skipBraces(src, i);
      props.push(transform(src.slice(i + 1, end - 1)).trim());
      i = end;
      continue;
    }
    ID.lastIndex = i;
    const attr = ID.exec(src)[0];
    i = ID.lastIndex;
    ws();
    if (src[i] !== '=') { props.push(`${JSON.stringify(attr)}: true`); continue; }
    i++;
    ws();
    if (src[i] === '{') {
      const end = skipBraces(src, i);
      props.push(`${JSON.stringify(attr)}: (${transform(src.slice(i + 1, end - 1))})`);
      i = end;
    } else {
      const end = src.indexOf(src[i], i + 1);
      props.push(`${JSON.stringify(attr)}: ${JSON.stringify(src.slice(i + 1, end))}`);
      i = end + 1;
    }
  }
  const children = [];
  for (;;) {
    const next = src.slice(i).search(/[<{]/) + i;
    const text = jsxText(src.slice(i, next));
    if (text) children.push(text);
    i = next;
    if (src[i] === '<' && src[i + 1] === '/') {
      i = src.indexOf('>', i) + 1;
      break;
    }
    if (src[i] === '<') {
      const el = parseElement(src, i);
      children.push(el.code);
      i = el.end;
    } else {
      const end = skipBraces(src, i);
      const expr = transform(src.slice(i + 1, end - 1));
      if (expr.replace(/\/\*[\s\S]*?\*\//g, '').trim()) children.push(`(${expr})`);
      i = end;
    }
  }
  const head = `h(${name}, ${props.length ? `{ ${props.join(', ')} }` : 'null'}`;
  return { code: children.length ? `${head}, ${children.join(', ')})` : `${head})`, end: i };
}

export function transform(src) {
  let out = '';
  let last = 0;
  for (let i = 0; i < src.length;) {
    if (isJsxStart(src, i)) {
      const el = parseElement(src, i);
      out += src.slice(last, i) + el.code;
      i = last = el.end;
      continue;
    }
    i = skipToken(src, i);
  }
  return out + src.slice(last);
}
