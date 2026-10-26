// Scans a ported plugin dir before it's installed. It strips Unicode tag
// characters (U+E0000–E007F, invisible prompt-injection carriers), flags risky
// patterns, checks agy's rule and skill size limits, and infers the capability
// tier with the same names and meaning as Hangar's TIER_*.
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { extname, join } from 'node:path';

import { RULE_BYTES, RULES_BUDGET_TOKENS } from './rules-compiler.mjs';
import { splitFrontmatter } from './yaml-lite.mjs';

export const TIERS = ['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL'];
const MAX_SCAN_BYTES = 1_000_000;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.wasm', '.woff', '.woff2', '.ttf', '.exe', '.dll', '.so', '.dylib']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const BIDI = /[‪-‮⁦-⁩]/;
const PATTERNS = [
  ['pipe-to-shell', 'high', /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i],
  ['pipe-to-shell', 'high', /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(iex|Invoke-Expression)\b/i],
  ['decode-and-exec', 'high', /base64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z)?sh\b/i],
  ['decode-and-exec', 'high', /\b(eval|exec|Function)\s*\(\s*(atob|Buffer\.from|base64\.b64decode)\s*\(/],
  ['decode-and-exec', 'high', /FromBase64String\([^\n]*\)[^\n]*(iex|Invoke-Expression)/i],
  ['encoded-powershell', 'high', /\bpowershell(\.exe)?\b[^\n]*\s-(e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i],
];
const TOKEN = /[A-Za-z0-9+/=_-]{40,}/g;

export function shannon(s) {
  const counts = {};
  for (const c of s) counts[c] = (counts[c] ?? 0) + 1;
  return Object.values(counts).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

// A long token that reads like a key or an encoded payload, not like an
// alphabet table, a URL path or a subresource-integrity hash.
export function looksRandom(token, before = '') {
  if (shannon(token) <= 4.5) return false;
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/\d/.test(token)) return false;
  if (/sha(256|384|512)-$/.test(before) || /^sha(256|384|512)-/.test(token)) return false;
  if ((token.match(/\//g) ?? []).length >= 2 && !/[+=]/.test(token)) return false;
  for (let i = 0, run = 1; i < token.length - 1; i++) {
    run = token.charCodeAt(i + 1) === token.charCodeAt(i) + 1 ? run + 1 : 1;
    if (run >= 6) return false;
  }
  return true;
}

function* walk(dir, rel = '') {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const path = rel ? `${rel}/${entry}` : entry;
    if (statSync(full).isDirectory()) yield* walk(full, path);
    else yield { full, path };
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function auditText(path, text) {
  const flags = [];
  for (const [kind, severity, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) flags.push({ kind, severity, file: path, line: lineOf(text, m.index), excerpt: m[0].slice(0, 120) });
  }
  if (BIDI.test(text)) flags.push({ kind: 'bidi-control', severity: 'medium', file: path, line: lineOf(text, text.search(BIDI)) });
  // Lockfiles and source maps are full of hashes; skip them for entropy.
  if (!/(\.lock|lock\.json|\.map)$/i.test(path)) {
    for (const m of text.matchAll(TOKEN)) {
      if (looksRandom(m[0], text.slice(Math.max(0, m.index - 7), m.index))) {
        flags.push({ kind: 'high-entropy', severity: 'medium', file: path, line: lineOf(text, m.index), excerpt: `${m[0].slice(0, 12)}…` });
        break;
      }
    }
  }
  return flags;
}

function readJsonIf(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

// TIER_2: anything that runs a local command (hooks, stdio MCP servers, sidecars).
// TIER_3: subagents, or hooks that steer the agent loop (Stop, PostInvocation).
export function inferTier(pluginDir) {
  const reasons = [];
  let rank = 0;
  const hooks = readJsonIf(join(pluginDir, 'hooks.json')) ?? {};
  const events = new Set(Object.values(hooks).flatMap((h) => Object.keys(h ?? {})).filter((e) => e !== 'enabled'));
  if (events.size) { rank = Math.max(rank, 1); reasons.push(`hooks: ${[...events].join(', ')}`); }
  if (events.has('Stop') || events.has('PostInvocation')) { rank = 2; reasons.push('a hook can keep the agent running'); }
  const servers = Object.entries(readJsonIf(join(pluginDir, 'mcp_config.json'))?.mcpServers ?? {});
  if (servers.length) {
    rank = Math.max(rank, 1);
    reasons.push(`MCP servers: ${servers.map(([n]) => n).join(', ')}`);
  }
  const agentsDir = join(pluginDir, 'agents');
  const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
  if (agents.length) { rank = 2; reasons.push(`agents: ${agents.map((f) => f.replace(/\.md$/, '')).join(', ')}`); }
  // Sidecars, including ported UI mods, whose mod.json lists their scan's Tier 3 reasons.
  const sidecarsDir = join(pluginDir, 'sidecars');
  const sidecars = existsSync(sidecarsDir) ? readdirSync(sidecarsDir).filter((d) => existsSync(join(sidecarsDir, d, 'sidecar.json'))) : [];
  if (sidecars.length) { rank = Math.max(rank, 1); reasons.push(`sidecars: ${sidecars.join(', ')} (a full Node process outside agy's permission prompts)`); }
  for (const id of sidecars) {
    const mod = readJsonIf(join(sidecarsDir, id, 'mod.json'));
    if (mod?.tier !== TIERS[2]) continue;
    rank = 2;
    reasons.push(`UI mod ${id}: ${(mod.tierReasons ?? []).slice(1).join(', ')}`);
  }
  return { tier: TIERS[rank], reasons };
}

export function auditPlugin(pluginDir) {
  const flags = [];
  const warnings = [];
  let alwaysOnBytes = 0;
  for (const { full, path } of walk(pluginDir)) {
    if (BINARY_EXT.has(extname(path).toLowerCase())) continue;
    // One descriptor for the size check, the read and the rewrite, so the file
    // can't be swapped between them.
    const fd = openSync(full, 'r+');
    let text;
    try {
      if (fstatSync(fd).size > MAX_SCAN_BYTES) { warnings.push(`audit: ${path} is over 1 MB and wasn't scanned`); continue; }
      const buffer = readFileSync(fd);
      if (buffer.includes(0)) continue;
      text = buffer.toString('utf8');
      const tags = text.match(TAGS);
      if (tags) {
        text = text.replace(TAGS, '');
        const stripped = Buffer.from(text, 'utf8');
        ftruncateSync(fd, 0);
        writeSync(fd, stripped, 0, stripped.length, 0);
        flags.push({ kind: 'unicode-tags-stripped', severity: 'high', file: path, count: tags.length });
      }
    } finally {
      closeSync(fd);
    }
    flags.push(...auditText(path, text));
    if (/^rules\/[^/]+\.md$/i.test(path)) {
      if (Buffer.byteLength(text) > RULE_BYTES) flags.push({ kind: 'rule-over-limit', severity: 'medium', file: path, bytes: Buffer.byteLength(text) });
      let alwaysOn = /^rules\/agents\.md$/i.test(path);
      try { alwaysOn ||= splitFrontmatter(text).data.trigger === 'always_on'; } catch {}
      if (alwaysOn) alwaysOnBytes += Buffer.byteLength(text);
    }
  }
  const tokens = Math.ceil(alwaysOnBytes / 4);
  if (tokens > RULES_BUDGET_TOKENS) flags.push({ kind: 'rules-over-budget', severity: 'medium', tokens });
  return { flags, warnings, ...inferTier(pluginDir) };
}
