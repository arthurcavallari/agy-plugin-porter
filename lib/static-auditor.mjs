// Scans a ported plugin dir before it's installed. It strips Unicode tag
// characters (U+E0000–E007F, invisible prompt-injection carriers), flags risky
// patterns, checks agy's rule and skill size limits, and infers the capability
// tier with the same names and meaning as Hangar's TIER_*.
import { closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

import { extractServerMap } from './manifest-sanitizer.mjs';
import { RULE_BYTES, RULES_BUDGET_TOKENS } from './rules-compiler.mjs';
import { splitFrontmatter } from './yaml-lite.mjs';

export const TIERS = ['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL'];
const MAX_SCAN_BYTES = 1_000_000;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.wasm', '.woff', '.woff2', '.ttf', '.exe', '.dll', '.so', '.dylib']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
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
    let lst;
    try { lst = lstatSync(full); } catch { continue; }
    if (lst.isSymbolicLink()) continue;
    const path = rel ? `${rel}/${entry}` : entry;
    if (lst.isDirectory()) yield* walk(full, path);
    else if (lst.isFile()) yield { full, path };
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

function collectHookEvents(obj, events) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'enabled' || k === 'description' || k === 'modules') continue;
    if (Array.isArray(v)) events.add(k);
    else if (v && typeof v === 'object') collectHookEvents(v, events);
  }
}

// TIER_2: anything that runs a local command (hooks, stdio MCP servers, sidecars) or renders SEP-1865 MCP App views.
// TIER_3: subagents, hooks that steer the agent loop (Stop, PostInvocation), or MCP App views that post agent-steering messages.
const MCP_APP_CODE_EXT = /\.(?:m?[jt]sx?|cjs|cts|py)$/i;
const MCP_APP_SKIP_PATH = /^(?:\.[^/]+\/)?(?:skills|rules|agents|commands)\//i;
const MCP_APP_MARKERS = [
  /\bui:\/\/[a-z0-9._-]+/i,
  /text\/html\s*;\s*profile=mcp-app/i,
  /@modelcontextprotocol\/ext-apps/,
];
const MCP_APP_MESSAGE_MARKERS = [
  /\bui\/message\b/,
  /com\.google\.antigravity\/message/,
];
const MAX_MCP_APP_SCAN_BYTES = 5_000_000;

function collectMcpServers(pluginDir) {
  const mcpMap = {};
  for (const rel of ['mcp_config.json', '.mcp.json', 'mcp.json']) {
    Object.assign(mcpMap, extractServerMap(readJsonIf(join(pluginDir, rel))));
  }
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']) {
    const manifest = readJsonIf(join(pluginDir, rel));
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
      Object.assign(mcpMap, extractServerMap({ mcpServers: manifest.mcpServers }));
    }
  }
  return Object.entries(mcpMap);
}

export function detectMcpAppSignals(pluginDir, servers = collectMcpServers(pluginDir)) {
  if (!servers.length || !existsSync(pluginDir)) return { hasMcpApp: false, hasUiMessage: false };
  let hasMcpApp = false;
  let hasUiMessage = false;
  for (const { full, path } of walk(pluginDir)) {
    if (!MCP_APP_CODE_EXT.test(path) || MCP_APP_SKIP_PATH.test(path)) continue;
    let buf;
    try {
      const fd = openSync(full, 'r');
      try {
        if (fstatSync(fd).size > MAX_MCP_APP_SCAN_BYTES) continue;
        buf = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (!hasMcpApp && MCP_APP_MARKERS.some((re) => re.test(text))) hasMcpApp = true;
    if (!hasUiMessage && MCP_APP_MESSAGE_MARKERS.some((re) => re.test(text))) hasUiMessage = true;
    if (hasMcpApp && hasUiMessage) break;
  }
  return { hasMcpApp, hasUiMessage: hasMcpApp && hasUiMessage };
}

const SIDECAR_AGENT_CONTROL_MARKERS = [
  /\bsidecar(?:\?\.|\.)agent(?:\?\.|\.)(?:sendMessage|startConversation|newConversation)\b/,
  /['"](?:SendUserCascadeMessage|StartCascade)['"]/,
  /['"](?:send-message|new-conversation)['"]|\bagentapi\s+(?:send-message|new-conversation)\b/,
];

function hasSidecarAgentControlSource(scDir, isPluginRoot = false) {
  if (!existsSync(scDir)) return false;
  for (const { full, path } of walk(scDir)) {
    if (!MCP_APP_CODE_EXT.test(path)) continue;
    if (isPluginRoot && (MCP_APP_SKIP_PATH.test(path) || /^sidecars\//i.test(path))) continue;
    let buf;
    try {
      const fd = openSync(full, 'r');
      try {
        if (fstatSync(fd).size > MAX_MCP_APP_SCAN_BYTES) continue;
        buf = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (SIDECAR_AGENT_CONTROL_MARKERS.some((re) => re.test(text))) return true;
  }
  return false;
}

function collectPluginSidecars(pluginDir) {
  const found = [];
  const seen = new Set();
  let externalReason = '';
  const resolvedPluginRoot = resolve(pluginDir);

  const addSidecar = (id, dir, isPluginRoot = false) => {
    const manifestPath = resolve(dir, 'sidecar.json');
    if (seen.has(manifestPath) || !existsSync(manifestPath)) return false;
    seen.add(manifestPath);
    found.push({
      id,
      dir,
      isPluginRoot,
      manifest: readJsonIf(manifestPath),
      mod: readJsonIf(join(dir, 'mod.json')),
    });
    return true;
  };

  if (existsSync(join(pluginDir, 'sidecar.json'))) {
    const pluginManifest = readJsonIf(join(pluginDir, 'plugin.json'));
    addSidecar(pluginManifest?.name || basename(resolvedPluginRoot) || 'root', pluginDir, true);
  }

  const sidecarsDir = join(pluginDir, 'sidecars');
  if (existsSync(sidecarsDir)) {
    try {
      if (!lstatSync(sidecarsDir).isSymbolicLink()) {
        for (const d of readdirSync(sidecarsDir)) {
          const subDir = join(sidecarsDir, d);
          try {
            if (!lstatSync(subDir).isSymbolicLink() && lstatSync(subDir).isDirectory()) {
              addSidecar(d, subDir, false);
            }
          } catch {}
        }
      }
    } catch {}
  }

  const sidecarsCfgPath = join(pluginDir, 'sidecars.json');
  if (existsSync(sidecarsCfgPath)) {
    const cfg = readJsonIf(sidecarsCfgPath);
    const isPlain = cfg && typeof cfg === 'object' && !Array.isArray(cfg);
    if (!isPlain) {
      externalReason = 'sidecars.json is malformed or unverified';
    } else if (cfg.inherits !== undefined && (!Array.isArray(cfg.inherits) || cfg.inherits.length > 0)) {
      externalReason = 'sidecars.json inherits external configuration';
    } else if (cfg.entries !== undefined && !Array.isArray(cfg.entries)) {
      externalReason = 'sidecars.json entries is malformed';
    } else if (Array.isArray(cfg.entries)) {
      for (const entry of cfg.entries) {
        const rawPath = typeof entry?.path === 'string' ? entry.path.trim() : '';
        if (!rawPath || rawPath.startsWith('~/') || isAbsolute(rawPath) || win32.isAbsolute(rawPath)) {
          externalReason = `sidecars.json references external sidecar path "${rawPath || '(invalid)'}"`;
          break;
        }
        const entryAbs = resolve(resolvedPluginRoot, rawPath);
        const rel = relative(resolvedPluginRoot, entryAbs);
        if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(entryAbs)) {
          externalReason = `sidecars.json references path outside or missing from plugin ("${rawPath}")`;
          break;
        }
        try {
          if (lstatSync(entryAbs).isSymbolicLink()) {
            externalReason = `sidecars.json references symbolic link "${rawPath}"`;
            break;
          }
          addSidecar(basename(entryAbs), entryAbs, rel === '');
          for (const sub of readdirSync(entryAbs, { withFileTypes: true })) {
            if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
            addSidecar(sub.name, join(entryAbs, sub.name), false);
          }
        } catch {
          externalReason = `sidecars.json entry "${rawPath}" could not be inspected`;
          break;
        }
      }
    }
  }

  return { sidecars: found, hasSidecarsJson: existsSync(sidecarsCfgPath), externalReason };
}

export function inferTier(pluginDir) {
  const reasons = [];
  let rank = 0;
  const events = new Set();
  for (const rel of ['hooks.json', 'hooks/hooks.json', '.claude-plugin/hooks.json']) {
    collectHookEvents(readJsonIf(join(pluginDir, rel)), events);
  }
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = readJsonIf(join(pluginDir, rel));
    if (manifest?.hooks && typeof manifest.hooks === 'object') collectHookEvents(manifest.hooks, events);
  }
  if (events.size) { rank = Math.max(rank, 1); reasons.push(`hooks: ${[...events].join(', ')}`); }
  if (events.has('Stop') || events.has('PostInvocation')) { rank = 2; reasons.push('a hook can keep the agent running'); }
  const servers = collectMcpServers(pluginDir);
  if (servers.length) {
    rank = Math.max(rank, 1);
    reasons.push(`MCP servers: ${servers.map(([n]) => n).join(', ')}`);
    const mcpApp = detectMcpAppSignals(pluginDir, servers);
    if (mcpApp.hasMcpApp) {
      rank = Math.max(rank, 1);
      reasons.push(`MCP App UI views (SEP-1865 ${'ui:' + '//'})`);
      if (mcpApp.hasUiMessage) {
        rank = 2;
        reasons.push(`an MCP App view can send messages into the conversation (${'ui/' + 'message'})`);
      }
    }
  }
  const agentsDir = join(pluginDir, 'agents');
  const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
  if (agents.length) { rank = Math.max(rank, 2); reasons.push(`agents: ${agents.map((f) => f.replace(/\.md$/, '')).join(', ')}`); }
  // Sidecars across sidecars/*, root sidecar.json, and sidecars.json (including ported UI mods).
  const { sidecars, hasSidecarsJson, externalReason } = collectPluginSidecars(pluginDir);
  if (sidecars.length || hasSidecarsJson) {
    rank = Math.max(rank, 1);
    const label = sidecars.length ? sidecars.map((s) => s.id).join(', ') : 'sidecars.json';
    reasons.push(`sidecars: ${label} (a full Node process outside agy's permission prompts)`);
  }
  if (externalReason) {
    rank = 2;
    reasons.push(externalReason);
  }
  for (const { id, dir, isPluginRoot, manifest: sc, mod } of sidecars) {
    if (mod) {
      if (mod.tier === TIERS[2]) {
        rank = 2;
        reasons.push(`UI mod ${id}: ${(mod.tierReasons ?? []).slice(1).join(', ')}`);
      }
      continue;
    }
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
      rank = 2;
      reasons.push(`sidecar ${id}: malformed sidecar.json cannot verify non-interactive permissions`);
      continue;
    }
    if (sc.sandbox?.disable_sandbox === true || sc.sandbox?.disableSandbox === true) {
      reasons.push(`sidecar ${id}: disables process sandbox (sandbox.disable_sandbox: true)`);
    }
    const rawAllowedRpcs = [
      ...(Array.isArray(sc.sandbox?.allowed_rpcs) ? sc.sandbox.allowed_rpcs : []),
      ...(Array.isArray(sc.sandbox?.allowedRpcs) ? sc.sandbox.allowedRpcs : []),
    ]
      .filter((r) => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim());
    if (rawAllowedRpcs.length > 0) {
      reasons.push(`sidecar ${id}: declares sandbox RPC allowlist (${[...new Set(rawAllowedRpcs)].join(', ')})`);
    }
    if (typeof sc.builtin === 'string' && sc.builtin.trim() === 'schedule') {
      rank = 2;
      reasons.push(`sidecar ${id}: scheduled automation ("builtin": "schedule")`);
    }
    if (sc.agent_permissions?.allows_user_interactions === true) {
      rank = 2;
      reasons.push(`sidecar ${id}: agent_permissions.allows_user_interactions is true`);
    }
    if (Array.isArray(sc.agent_permissions?.access_grants) && sc.agent_permissions.access_grants.length > 0) {
      rank = 2;
      reasons.push(`sidecar ${id}: grants agent tool permissions (${sc.agent_permissions.access_grants.join(', ')})`);
    }
    if (Array.isArray(sc.agent_permissions?.workspace_uris) && sc.agent_permissions.workspace_uris.length > 0) {
      rank = 2;
      reasons.push(`sidecar ${id}: grants agent workspace access (${sc.agent_permissions.workspace_uris.join(', ')})`);
    }
    if (hasSidecarAgentControlSource(dir, isPluginRoot)) {
      rank = 2;
      reasons.push(`sidecar ${id}: runtime source sends messages or starts agent conversations`);
    }
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

  const manifest = readJsonIf(join(pluginDir, 'plugin.json'));
  const pluginName = typeof manifest?.name === 'string' ? manifest.name : '';
  if (pluginName) {
    const mcpServers = {
      ...extractServerMap(readJsonIf(join(pluginDir, 'mcp_config.json'))),
      ...extractServerMap(readJsonIf(join(pluginDir, 'mcp.json'))),
    };
    for (const serverName of Object.keys(mcpServers)) {
      const prefix = `mcp_${pluginName}_${serverName}_`;
      if (!/^[a-zA-Z0-9_-]+_$/.test(prefix)) {
        warnings.push(`audit: MCP server "${serverName}" produces invalid tool prefix "${prefix}" (must match ^[a-zA-Z0-9_-]{1,64}$)`);
      } else if (prefix.length >= 64) {
        warnings.push(`audit: MCP server "${serverName}" prefix "${prefix}" is ${prefix.length} chars, exceeding Antigravity's 64-char tool-name limit`);
      } else if (64 - prefix.length < 12) {
        warnings.push(`audit: MCP server "${serverName}" prefix "${prefix}" is ${prefix.length} chars, leaving only ${64 - prefix.length} chars under Antigravity's 64-char tool-name limit`);
      }
    }
    const sidecarsDir = join(pluginDir, 'sidecars');
    if (existsSync(sidecarsDir)) {
      for (const id of readdirSync(sidecarsDir)) {
        const mod = readJsonIf(join(sidecarsDir, id, 'mod.json'));
        if (!mod?.mcpServer) continue;
        const toolNames = [
          ...(mod.tools ?? []).map((t) => String(t.name)),
          ...(mod.commands ?? []).map((c) => `slash_${String(c.name).replace(/[^a-zA-Z0-9_-]/g, '_')}`),
        ];
        for (const tName of toolNames) {
          const fullName = `mcp_${pluginName}_${mod.mcpServer}_${tName}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fullName)) {
            warnings.push(`audit: UI mod "${id}" tool "${fullName}" (${fullName.length} chars) violates Antigravity's ^[a-zA-Z0-9_-]{1,64}$ MCP tool-name limit`);
          }
        }
      }
    }
  }

  return { flags, warnings, ...inferTier(pluginDir) };
}
