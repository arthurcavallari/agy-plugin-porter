// A YAML subset, enough for Markdown frontmatter and `.roomodes`: block maps and
// sequences, flow `[a, b]` / `{k: v}`, quoted and plain scalars, `|` / `>` block
// scalars, multi-line plain scalars and comments. Anchors, tags and multiple
// documents are not supported. Like agy's loader, it tolerates `: ` inside an
// unquoted value (`description: Runs checks: lint`).

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-[{][^:#]*?|-[^\s:#][^:#]*?)\s*:(?=\s|$)/;

function unquote(s) {
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && !(quote === '"' && s[i - 1] === '\\')) quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,]/.test(s[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function splitFlow(s) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

export function parseScalar(raw) {
  const s = stripComment(raw.trim());
  if (s === '') return null;
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const m = KEY.exec(part);
      if (m) obj[unquote(m[1])] = parseScalar(part.slice(m[0].length));
    }
    return obj;
  }
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^(null|Null|NULL|~)$/.test(s)) return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    .map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, text: raw.trim() }));
  let i = 0;
  if (lines[0]?.text === '---') i = 1;
  const blank = (l) => l.text === '' || l.text.startsWith('#');
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };
  const isSeq = (t) => t === '-' || t.startsWith('- ');

  function blockScalar(header, parentIndent) {
    const folded = header.startsWith('>');
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    while (i < lines.length && (lines[i].text === '' || lines[i].indent > parentIndent)) body.push(lines[i++]);
    const first = body.find((l) => l.text !== '');
    const ind = first ? first.indent : 0;
    const rows = body.map((l) => (l.text === '' ? '' : l.raw.slice(ind)));
    let out;
    if (folded) {
      out = '';
      rows.forEach((row, k) => {
        if (k === 0) out = row;
        else if (row === '' || rows[k - 1] === '' || /^\s/.test(row)) out += `\n${row}`;
        else out += ` ${row}`;
      });
      out = out.replace(/\n(?=\n)/g, '');
    } else out = rows.join('\n');
    const trimmed = out.replace(/\n+$/, '');
    if (chomp === 'strip') return trimmed;
    if (chomp === 'keep') return out.endsWith('\n') ? out : `${out}\n`;
    return trimmed === '' ? '' : `${trimmed}\n`;
  }

  // A value on the same line as its key or dash, with continuation lines for plain scalars.
  function inlineValue(rest, indent) {
    if (/^[|>][-+0-9]*$/.test(stripComment(rest))) return blockScalar(rest, indent);
    const value = parseScalar(rest);
    if (typeof value !== 'string' || /^["'[{]/.test(rest)) return value;
    let joined = value;
    while (i < lines.length && lines[i].text !== '' && lines[i].indent > indent && !KEY.test(lines[i].text) && !isSeq(lines[i].text)) {
      joined += ` ${stripComment(lines[i++].text)}`;
    }
    return joined;
  }

  function node(indent) {
    skip();
    if (i >= lines.length || lines[i].indent < indent) return null;
    return isSeq(lines[i].text) ? seq(lines[i].indent) : map(lines[i].indent);
  }

  function seq(indent) {
    const items = [];
    for (skip(); i < lines.length && lines[i].indent === indent && isSeq(lines[i].text); skip()) {
      const line = lines[i];
      const rest = line.text.slice(1).trimStart();
      if (rest === '' || rest.startsWith('#')) { i++; items.push(node(indent + 1)); continue; }
      if (isSeq(rest) || KEY.test(rest)) {
        // `- - x` or `- key: v`: reparse the rest as a node at its own column.
        const col = line.raw.indexOf(rest, line.indent + 1);
        lines[i] = { raw: ' '.repeat(col) + rest, indent: col, text: rest };
        items.push(node(col));
        continue;
      }
      i++;
      items.push(inlineValue(rest, indent));
    }
    return items;
  }

  function map(indent) {
    const obj = {};
    for (skip(); i < lines.length && lines[i].indent === indent; skip()) {
      const m = KEY.exec(lines[i].text);
      if (!m) throw new Error(`yaml: can't parse line ${i + 1}: ${lines[i].text}`);
      const key = unquote(m[1].trim());
      const rest = lines[i].text.slice(m[0].length).trim();
      i++;
      if (rest === '' || rest.startsWith('#')) {
        skip();
        const next = lines[i];
        obj[key] = next && (next.indent > indent || (next.indent === indent && isSeq(next.text))) ? node(next.indent) : null;
      } else obj[key] = inlineValue(rest, indent);
    }
    return obj;
  }

  const result = node(0);
  skip();
  if (i < lines.length && lines[i].text !== '---') throw new Error(`yaml: unexpected indentation at line ${i + 1}`);
  return result;
}

// Splits `---\n<yaml>\n---\n<body>`. Returns {data, body, hasFrontmatter}.
export function splitFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  return { data: parseYaml(m[1] ?? '') ?? {}, body: src.slice(m[0].length), hasFrontmatter: true };
}

function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  const plain = /^[A-Za-z0-9_./*][^\n:#]*$/.test(s) && s === s.trim()
    && !/^(true|false|null|yes|no|on|off|~|[-+]?\d+(\.\d+)?)$/i.test(s) && !/[[\]{},&*!|>'"%@`]/.test(s[0]);
  return plain ? s : JSON.stringify(s);
}

// Writes frontmatter from plain values; arrays become block lists, null/undefined are skipped.
export function formatFrontmatter(data, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(value.length ? `${key}:` : `${key}: []`);
      value.forEach((v) => lines.push(`  - ${scalar(v)}`));
    } else lines.push(`${key}: ${scalar(value)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body.replace(/^\n+/, '\n')}`;
}
