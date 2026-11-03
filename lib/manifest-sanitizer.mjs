// Writes the 7-key plugin.json and fixes MCP configs for agy:
// - rescues Claude's inline `mcpServers`, which `agy plugin install` drops
// - rewrites ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA} to ${PLUGIN_ROOT} /
//   ${PLUGIN_DATA}, which agy expands in `args`, `env` and `cwd` (live-tested
//   for args on 1.4.5)
// - turns absolute staging paths (agy expands Gemini's ${extensionPath} at
//   install time) back into ${PLUGIN_ROOT}, so the output doesn't point into
//   the throwaway staging home
// - drops the source manifests agy leaves behind
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, normalize } from 'node:path';

import { readJson } from './detector.mjs';

export const MANIFEST_KEYS = ['name', 'displayName', 'description', 'version', 'logo', 'suggestedPrompts', 'disabled'];
const LOGO_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp']);
const SOURCE_ARTIFACTS = ['.claude-plugin', 'gemini-extension.json', '.mcp.json', 'mcp.json'];

function readIf(file) {
  try { return existsSync(file) ? readJson(file) : null; } catch { return null; }
}

export function sourceManifest(srcDir, ecosystems) {
  if (ecosystems.includes('claude')) return readIf(join(srcDir, '.claude-plugin/plugin.json')) ?? {};
  if (ecosystems.includes('gemini')) return readIf(join(srcDir, 'gemini-extension.json')) ?? {};
  return readIf(join(srcDir, 'plugin.json')) ?? {};
}

export function buildManifest(source, { slug, ecosystems, pluginDir, report }) {
  const out = { name: slug };
  if (typeof source.displayName === 'string') out.displayName = source.displayName;
  else if (typeof source.name === 'string' && source.name !== slug) out.displayName = source.name;
  out.description = typeof source.description === 'string' && source.description.trim()
    ? source.description.trim()
    : `Ported from ${ecosystems.join(' + ')} by agy-plugin-porter.`;
  if (typeof source.version === 'string') out.version = source.version;
  if (typeof source.logo === 'string') {
    const ok = !isAbsolute(source.logo) && !/^[a-z]+:/i.test(source.logo) && LOGO_EXT.has(extname(source.logo).toLowerCase())
      && existsSync(join(pluginDir, source.logo));
    if (ok) out.logo = source.logo;
    else report.warnings.push(`plugin.json: dropped logo "${source.logo}" (must be a relative .png/.svg/.jpg/.jpeg/.webp in the plugin)`);
  }
  if (Array.isArray(source.suggestedPrompts)) {
    const prompts = source.suggestedPrompts.filter((p) => typeof p === 'string' && p.trim()).slice(0, 3);
    if (prompts.length) out.suggestedPrompts = prompts;
  }
  if (typeof source.disabled === 'boolean') out.disabled = source.disabled;
  // Keys the porter consumes elsewhere aren't "dropped".
  const consumed = new Set([...MANIFEST_KEYS, 'mcpServers', 'hooks', 'contextFileName', 'types', '$schema']);
  const dropped = Object.keys(source).filter((k) => !consumed.has(k));
  if (dropped.length) report.warnings.push(`plugin.json: dropped ${dropped.map((k) => `"${k}"`).join(', ')} (agy reads only ${MANIFEST_KEYS.join(', ')})`);
  for (const key of ['commands', 'agents', 'skills', 'outputStyles']) {
    if (key in source && typeof source[key] !== 'boolean') {
      report.warnings.push(`plugin.json: custom "${key}" paths aren't followed; only the default folders are ported`);
    }
  }
  return out;
}

export function extractServerMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) return obj.mcpServers;
  const entries = Object.entries(obj).filter(([k, v]) =>
    !k.startsWith('$') && !['version', 'description', 'name'].includes(k)
    && v && typeof v === 'object' && !Array.isArray(v)
    && ('command' in v || 'url' in v || 'httpUrl' in v || 'serverUrl' in v));
  return Object.fromEntries(entries);
}

// Inline servers in Claude's manifest: an object, or a path to a JSON file.
function inlineServers(source, srcDir, report) {
  const declared = source.mcpServers;
  if (!declared) return {};
  if (typeof declared === 'object' && !Array.isArray(declared)) return extractServerMap({ mcpServers: declared });
  if (typeof declared === 'string') {
    const file = readIf(join(srcDir, declared));
    if (file) return extractServerMap(file);
    report.unported.push({ item: `mcp:${declared}`, reason: "can't read the MCP config the manifest points to" });
  }
  return {};
}

const ROOT_VARS = [
  [/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, '${PLUGIN_ROOT}'],
  [/\$PLUGIN_ROOT\b/g, '${PLUGIN_ROOT}'],
  [/\$\{CLAUDE_PLUGIN_DATA\}|\$CLAUDE_PLUGIN_DATA\b/g, '${PLUGIN_DATA}'],
  [/\$PLUGIN_DATA\b/g, '${PLUGIN_DATA}'],
  [/\$\{extensionPath\}|\$extensionPath\b/g, '${PLUGIN_ROOT}'],
  [/\$\{GEMINI_PLUGIN_PATH\}|\$GEMINI_PLUGIN_PATH\b/g, '${PLUGIN_ROOT}'],
  [/\$\{\/\}/g, '/'],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rewriteString(value, stagedPaths) {
  let out = value;
  for (const [re, to] of ROOT_VARS) out = out.replace(re, to);
  for (const staged of stagedPaths) {
    for (const form of new Set([staged, staged.replace(/\\/g, '/'), staged.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escapeRe(form), process.platform === 'win32' ? 'gi' : 'g'), '${PLUGIN_ROOT}');
    }
  }
  return out;
}

const PLACEHOLDER = /\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})([^}]+)\}/g;

export function fixMcpServers(servers, { stagedPaths = [], report }) {
  const fixed = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
    if (name.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    const s = structuredClone(server);
    if (Array.isArray(s.args)) s.args = s.args.map((a) => (typeof a === 'string' ? rewriteString(a, stagedPaths) : a));
    if (typeof s.cwd === 'string') s.cwd = rewriteString(s.cwd, stagedPaths);
    if (s.env && typeof s.env === 'object') {
      s.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, typeof v === 'string' ? rewriteString(v, stagedPaths) : v]));
    }
    if (typeof s.url === 'string' && !s.url.trim()) delete s.url;
    if (typeof s.httpUrl === 'string' && !s.httpUrl.trim()) delete s.httpUrl;
    const rawRemoteUrl = typeof s.url === 'string' ? s.url : (typeof s.httpUrl === 'string' ? s.httpUrl : null);
    if (!s.serverUrl && rawRemoteUrl) {
      s.serverUrl = rewriteString(rawRemoteUrl, stagedPaths);
      delete s.url;
      delete s.httpUrl;
    } else if (typeof s.serverUrl === 'string') {
      s.serverUrl = rewriteString(s.serverUrl, stagedPaths);
    }
    if (typeof s.serverUrl === 'string' && ['http', 'streamable-http', 'sse'].includes(s.type)) {
      delete s.type;
    }
    if (s.headers && typeof s.headers === 'object') {
      s.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, typeof v === 'string' ? rewriteString(v, stagedPaths) : v]));
    }
    if (typeof s.command === 'string') {
      const command = rewriteString(s.command, stagedPaths);
      if (command.includes('${PLUGIN_ROOT}') || command.includes('${PLUGIN_DATA}')) {
        report.unported.push({ item: `mcp:${name}`, reason: 'the command uses the plugin path, which agy expands only in args, env and cwd' });
        continue;
      }
      s.command = command;
    }
    const others = new Set();
    for (const text of [s.command, s.url, s.serverUrl, ...(s.args ?? []), ...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})]) {
      if (typeof text === 'string') for (const m of text.matchAll(PLACEHOLDER)) others.add(m[1]);
    }
    if (others.size) {
      report.warnings.push(`mcp:${name}: ${[...others].map((v) => `\${${v}}`).join(', ')} is passed literally unless declared in agy's "variables" (format unverified)`);
    }
    fixed[name] = s;
    report.ported.push(`mcp:${name}`);
  }
  return fixed;
}

// Rewrites plugin.json and mcp_config.json in a staged plugin dir.
export function sanitizeManifest(pluginDir, { srcDir, ecosystems, slug, stagedPaths = [] }) {
  const report = { ported: [], unported: [], warnings: [] };
  const source = sourceManifest(srcDir, ecosystems);
  writeFileSync(join(pluginDir, 'plugin.json'), `${JSON.stringify(buildManifest(source, { slug, ecosystems, pluginDir, report }), null, 2)}\n`);
  report.ported.push('manifest');

  const configFile = join(pluginDir, 'mcp_config.json');
  const servers = {
    ...(srcDir ? extractServerMap(readIf(join(srcDir, 'mcp.json'))) : {}),
    ...(srcDir ? extractServerMap(readIf(join(srcDir, '.mcp.json'))) : {}),
    ...extractServerMap(readIf(join(pluginDir, 'mcp.json'))),
    ...extractServerMap(readIf(join(pluginDir, '.mcp.json'))),
    ...extractServerMap(readIf(configFile)),
  };
  if (ecosystems.includes('claude') || ecosystems.includes('gemini')) {
    for (const [name, server] of Object.entries(inlineServers(source, srcDir, report))) {
      if (name in servers && ecosystems.includes('claude')) report.warnings.push(`mcp:${name}: defined in both .mcp.json and plugin.json; kept .mcp.json's`);
      else if (!(name in servers)) servers[name] = server;
    }
  }
  if (ecosystems.includes('gemini')) {
    for (const key of ['excludeTools', 'settings']) {
      if (source[key]) report.unported.push({ item: `gemini:${key}`, reason: `agy has no equivalent of gemini-extension.json "${key}"` });
    }
  }
  const fixed = fixMcpServers(servers, { stagedPaths: stagedPaths.map(normalize), report });
  if (Object.keys(fixed).length) writeFileSync(configFile, `${JSON.stringify({ mcpServers: fixed }, null, 2)}\n`);
  else rmSync(configFile, { force: true });

  for (const artifact of SOURCE_ARTIFACTS) rmSync(join(pluginDir, artifact), { recursive: true, force: true });
  return report;
}
