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
import { isInside, removeTree } from './source.mjs';

export const MANIFEST_KEYS = [
  '$schema', 'name', 'displayName', 'description', 'version',
  'author', 'homepage', 'repository', 'license', 'logo',
  'suggestedPrompts', 'themes', 'disabled',
];
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
  const out = {};
  if (typeof source.$schema === 'string' && source.$schema.includes('agent-plugins.org')) {
    out.$schema = source.$schema.trim();
  }
  out.name = slug;
  if (typeof source.displayName === 'string') out.displayName = source.displayName;
  else if (typeof source.name === 'string' && source.name !== slug) out.displayName = source.name;
  out.description = typeof source.description === 'string' && source.description.trim()
    ? source.description.trim()
    : `Ported from ${ecosystems.join(' + ')} by agy-plugin-porter.`;
  out.version = typeof source.version === 'string' && source.version.trim() ? source.version.trim() : '0.1.0';
  if (typeof source.author === 'string' && source.author.trim()) {
    out.author = { name: source.author.trim() };
  } else if (source.author && typeof source.author === 'object' && !Array.isArray(source.author) && typeof source.author.name === 'string' && source.author.name.trim()) {
    const author = { name: source.author.name.trim() };
    if (typeof source.author.email === 'string' && source.author.email.trim()) author.email = source.author.email.trim();
    if (typeof source.author.url === 'string' && /^https?:\/\//i.test(source.author.url.trim())) author.url = source.author.url.trim();
    out.author = author;
  }
  if (typeof source.homepage === 'string' && /^https?:\/\//i.test(source.homepage.trim())) {
    out.homepage = source.homepage.trim();
  }
  if (typeof source.repository === 'string' && source.repository.trim()) {
    out.repository = source.repository.trim();
  } else if (source.repository && typeof source.repository === 'object' && !Array.isArray(source.repository) && typeof source.repository.url === 'string' && source.repository.url.trim()) {
    out.repository = {
      ...(typeof source.repository.type === 'string' && source.repository.type.trim() ? { type: source.repository.type.trim() } : {}),
      url: source.repository.url.trim(),
    };
  }
  if (typeof source.license === 'string' && source.license.trim()) {
    out.license = source.license.trim();
  }
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
  if (Array.isArray(source.themes)) {
    const themes = source.themes.filter((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.name === 'string' && t.name.trim());
    if (themes.length) out.themes = themes;
  }
  if (typeof source.disabled === 'boolean') out.disabled = source.disabled;
  // Keys the porter consumes elsewhere aren't "dropped".
  const consumed = new Set([...MANIFEST_KEYS, 'mcpServers', 'hooks', 'contextFileName', 'types']);
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
    const path = join(srcDir, declared);
    if (existsSync(path) && !isInside(srcDir, path)) {
      report.unported.push({ item: `mcp:${declared}`, reason: 'the MCP config the manifest points to is outside the plugin' });
      return {};
    }
    const file = readIf(path);
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
  [/\$\{env:([A-Za-z_]\w*)\}/g, '${$1}'],
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

const PLACEHOLDER = /\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\}|flag:)([^}]+)\}/g;
const DEFAULT_EXPR = /\$\{([A-Za-z_]\w*):-([^}]*)\}/g;
const SECRET_VAR = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|PAT|CREDENTIAL/i;

function resolveDefaults(value, outName, report) {
  return value.replace(DEFAULT_EXPR, (_, name, def) => {
    report.warnings.push(`mcp:${outName}: resolved \${${name}:-${def}} to default "${def}" (Antigravity does not expand :- defaults)`);
    return def;
  });
}

export function fixMcpServers(servers, { stagedPaths = [], slug, ecosystems = [], report }) {
  const fixed = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
    if (name.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    let outName = name;
    if (slug && `mcp_${slug}_${name}_`.length > 36) {
      let candidate = null;
      if (name === slug) {
        candidate = !('mcp' in servers) && !('mcp' in fixed) ? 'mcp' : (!('default' in servers) && !('default' in fixed) ? 'default' : null);
      } else if (name.startsWith(`${slug}-`) || name.startsWith(`${slug}_`)) {
        const trimmed = name.slice(slug.length + 1);
        if (trimmed && !(trimmed in servers) && !(trimmed in fixed)) candidate = trimmed;
      }
      if (candidate) {
        outName = candidate;
        report.warnings.push(`mcp:${name}: renamed server key to "${outName}" so Antigravity's mcp_${slug}_${outName}_<tool> prefix stays within the 64-char tool-name limit`);
      }
    }
    const s = structuredClone(server);
    if (Array.isArray(s.args)) s.args = s.args.map((a) => (typeof a === 'string' ? resolveDefaults(rewriteString(a, stagedPaths), outName, report) : a));
    if (typeof s.cwd === 'string') s.cwd = resolveDefaults(rewriteString(s.cwd, stagedPaths), outName, report);
    if (s.env && typeof s.env === 'object') {
      const nextEnv = {};
      for (const [k, v] of Object.entries(s.env)) {
        if (typeof v !== 'string') { nextEnv[k] = v; continue; }
        const rewritten = resolveDefaults(rewriteString(v, stagedPaths), outName, report);
        if (rewritten === `\${${k}}`) {
          report.warnings.push(`mcp:${outName}: removed self-referencing env "${k}: \${${k}}" so ${k} inherits from the host environment`);
          continue;
        }
        nextEnv[k] = rewritten;
      }
      if (Object.keys(nextEnv).length) s.env = nextEnv;
      else delete s.env;
    }
    if (typeof s.url === 'string' && !s.url.trim()) delete s.url;
    if (typeof s.httpUrl === 'string' && !s.httpUrl.trim()) delete s.httpUrl;
    if (s.headers && typeof s.headers === 'object') {
      s.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, typeof v === 'string' ? resolveDefaults(rewriteString(v, stagedPaths), outName, report) : v]));
    }
    const rawRemoteUrl = typeof s.url === 'string' ? s.url : (typeof s.httpUrl === 'string' ? s.httpUrl : null);
    const candidateUrl = typeof s.serverUrl === 'string' ? resolveDefaults(rewriteString(s.serverUrl, stagedPaths), outName, report)
      : (rawRemoteUrl ? resolveDefaults(rewriteString(rawRemoteUrl, stagedPaths), outName, report) : null);
    const isLegacySse = !s.command && candidateUrl && (
      s.type === 'sse'
      || (!s.type && !s.httpUrl && (ecosystems.includes('gemini') && typeof s.url === 'string' || /\/sse(?:\/?(?:\?.*)?)?$/i.test(candidateUrl)))
    );
    if (isLegacySse) {
      const headerArgs = Object.entries(s.headers ?? {})
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .flatMap(([k, v]) => ['--header', `${k}: ${v}`]);
      s.command = 'npx';
      s.args = ['-y', 'mcp-remote', candidateUrl, ...headerArgs];
      delete s.url;
      delete s.httpUrl;
      delete s.serverUrl;
      delete s.type;
      delete s.headers;
      report.warnings.push(`mcp:${outName}: bridged legacy SSE endpoint ${candidateUrl} via stdio mcp-remote (Antigravity supports Streamable HTTP only)`);
    } else {
      if (!s.serverUrl && rawRemoteUrl) {
        s.serverUrl = candidateUrl;
        delete s.url;
        delete s.httpUrl;
      } else if (typeof s.serverUrl === 'string') {
        s.serverUrl = candidateUrl;
      }
      if (typeof s.serverUrl === 'string' && ['http', 'streamable-http'].includes(s.type)) {
        delete s.type;
      }
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
      const existingVars = Array.isArray(s.variables) ? [...s.variables] : [];
      const declared = new Set(existingVars.map((v) => v?.name).filter(Boolean));
      for (const varName of others) {
        if (/^[A-Za-z_]\w*$/.test(varName) && !declared.has(varName)) {
          existingVars.push({
            name: varName,
            title: varName,
            description: `Value for ${varName}`,
            ...(SECRET_VAR.test(varName) ? { secret: true } : {}),
          });
          declared.add(varName);
        }
      }
      if (existingVars.length) s.variables = existingVars;
      report.warnings.push(`mcp:${outName}: declared ${[...others].map((v) => `\${${v}}`).join(', ')} in "variables" so Antigravity prompts for user values`);
    }
    fixed[outName] = s;
    report.ported.push(`mcp:${outName}`);
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
  const fixed = fixMcpServers(servers, { stagedPaths: stagedPaths.map(normalize), slug, ecosystems, report });
  if (Object.keys(fixed).length) writeFileSync(configFile, `${JSON.stringify({ mcpServers: fixed }, null, 2)}\n`);
  else rmSync(configFile, { force: true });

  for (const artifact of SOURCE_ARTIFACTS) removeTree(join(pluginDir, artifact));
  return report;
}
