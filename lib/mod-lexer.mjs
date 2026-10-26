// A small JS/TS lexer for the mod scanner. It doesn't parse: it blanks comments and
// the insides of strings, template text and regex literals, so structure (on(...),
// $.noun.method, brackets) can be matched with plain regexes on the result, and
// literal values read back from the source at the same offsets.
// A `/` after one of these starts a regex. `<` is left out so JSX's `</Tag>` stays code.
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%~^]$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

export function blank(src) {
  const out = src.split('');
  const fill = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const templates = []; // brace depth at each open `${`
  let depth = 0;
  let i = 0;
  const skipString = (q) => {
    const start = i++;
    while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    fill(start + 1, i);
    i++;
  };
  // Template text from i (just past ` or }) to the closing ` or the next ${.
  const skipTemplate = () => {
    const start = i;
    while (i < src.length && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i += src[i] === '\\' ? 2 : 1;
    fill(start, i);
    if (src[i] === '`') { i++; return; }
    templates.push(depth);
    depth++;
    i += 2;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      fill(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      fill(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      skipString(c);
    } else if (c === '`') {
      i++;
      skipTemplate();
    } else if (c === '/' && REGEX_BEFORE.test(out.slice(Math.max(0, i - 12), i).join('').trimEnd() || ';')) {
      const start = i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      fill(start + 1, i);
      i++;
    } else {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (templates.length && templates.at(-1) === depth) {
          templates.pop();
          i++;
          skipTemplate();
          continue;
        }
      }
      i++;
    }
  }
  return out.join('');
}

const PAIRS = { '(': ')', '[': ']', '{': '}' };

// Index of the bracket that closes the one at `open` in blanked code, or -1.
export function closeOf(code, open) {
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (PAIRS[c]) stack.push(PAIRS[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// The string literal whose opening quote is at `at` in code: {value, end} or null.
// Template literals count only without ${...} parts.
export function literalAt(code, src, at) {
  const q = code[at];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = code.indexOf(q, at + 1);
  if (end < 0) return null;
  const body = src.slice(at + 1, end);
  if (q === '`' && body.includes('${')) return null;
  const value = body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCodePoint(Number.parseInt(e.replace(/[ux{}]/g, ''), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] ?? e;
  });
  return { value, end };
}

// Top-level fields of the object literal at `open` (a `{` in code). Each value is
// {literal}, {ident} or {other}.
export function objectFields(code, src, open) {
  const close = closeOf(code, open);
  const fields = {};
  if (close < 0) return fields;
  let i = open + 1;
  while (i < close) {
    const key = /^\s*(?:([A-Za-z_$][\w$]*)|(["']))\s*/.exec(code.slice(i, close));
    if (!key) break;
    let name = key[1];
    let j = i + key[0].length;
    if (!name) {
      const lit = literalAt(code, src, i + key[0].indexOf(key[2]));
      if (!lit) break;
      name = lit.value;
      j = lit.end + 1;
      j += /^\s*/.exec(code.slice(j))[0].length;
    }
    let end = j;
    if (code[j] === ':') {
      end = j + 1 + /^\s*/.exec(code.slice(j + 1))[0].length;
      const lit = literalAt(code, src, end);
      const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(end));
      const after = (k) => /^\s*(?:as\s+const\s*)?[,}]/.test(code.slice(k, close + 1));
      if (lit && after(lit.end + 1)) fields[name] = { literal: lit.value };
      else if (ident && after(end + ident[0].length)) fields[name] = { ident: ident[0] };
      else fields[name] = { other: true };
    } else {
      fields[name] = { ident: name }; // shorthand { name }
    }
    // Skip to the next top-level comma.
    for (let k = end; k <= close; k++) {
      if (PAIRS[code[k]]) { k = closeOf(code, k); if (k < 0) return fields; continue; }
      if (code[k] === ',' || k === close) { i = k + 1; break; }
    }
  }
  return fields;
}
