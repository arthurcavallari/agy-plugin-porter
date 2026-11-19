// Turns Claude Code agents and Roo/Kilo modes into agy agents (agents/<name>.md).
// agy 1.4.x skips a Claude agent outright: `tools: Read, Grep` is a string
// where agy wants a list, and `model: sonnet` isn't an agy model tier. So
// tools are mapped to agy tool names, and models to agy's tiers (pro, flash,
// flash_lite, inherit). Anything that can't be mapped is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { rewriteRuleVars } from './rules-compiler.mjs';
import { slugifyName } from './skill-compiler.mjs';
import { AGENT_TOOLS, DEFAULT_AGENT_TOOLS, ROO_GROUPS, unmappedToolReason } from './tool-map.mjs';
import { formatFrontmatter, parseYaml, splitFrontmatter } from './yaml-lite.mjs';

// Names agy reserves for built-in agents (2.29.0–2.31.2 subagent registry).
const RESERVED = new Set(['self', 'research', 'image-generator', 'browser', 'deepagent', 'review-agent']);
const CLAUDE_AGENT_KEYS = new Set([
  'name', 'description', 'tools', 'model',
  'maxTurns', 'max_turns', 'permissionMode', 'execution_policy', 'agents', 'subagents',
]);
const POLICY_MAP = {
  turbo: 'turbo', bypasspermissions: 'turbo', acceptedits: 'turbo', dontask: 'turbo',
  auto: 'auto', default: 'auto', plan: 'auto',
  off: 'off', review: 'off',
};

const DEFAULT_MODEL_CATALOG_PATH = join(
  homedir(),
  '.gemini',
  'antigravity',
  'sidecar_data',
  'context-monitor',
  'data',
  'model-catalog-cache.json'
);
let cachedCatalogIndex = null;

function stripTieredFamily(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/-(?:minimal|low|medium|high|xhigh|max|thinking)$/i, '')
    .replace(/-tiered$/i, '');
}

function buildCatalogTierIndex(rawCatalog) {
  if (!rawCatalog || typeof rawCatalog !== 'object') return null;
  const src = rawCatalog.response && typeof rawCatalog.response === 'object' ? rawCatalog.response : rawCatalog;
  const tiered = src.tieredModelIds && typeof src.tieredModelIds === 'object'
    ? src.tieredModelIds
    : {};
  const flashLiteFamilies = new Set(
    (Array.isArray(tiered.flashLite) ? tiered.flashLite : []).map(stripTieredFamily).filter(Boolean)
  );
  const flashFamilies = new Set(
    (Array.isArray(tiered.flash) ? tiered.flash : []).map(stripTieredFamily).filter(Boolean)
  );
  const bySlug = new Map();
  const byEnumLower = new Map();
  const addEntry = (slugRaw, item) => {
    const slug = String(slugRaw || '').trim().toLowerCase();
    if (!slug || !item || typeof item !== 'object') return;
    const enumLower = String(item.modelEnum || item.model || item.modelOrAlias?.model || '').trim().toLowerCase();
    const norm = {
      slug,
      modelProvider: String(item.modelProvider || ''),
      apiProvider: String(item.apiProvider || ''),
    };
    bySlug.set(slug, norm);
    if (enumLower) byEnumLower.set(enumLower, norm);
  };
  if (src.modelsBySlug && typeof src.modelsBySlug === 'object') {
    for (const [k, v] of Object.entries(src.modelsBySlug)) addEntry(v?.modelId || k, v);
  }
  if (Array.isArray(src.models)) {
    for (const m of src.models) addEntry(m?.id || m?.modelId, m);
  } else if (src.models && typeof src.models === 'object') {
    for (const [k, v] of Object.entries(src.models)) addEntry(k, v);
  }
  return { flashLiteFamilies, flashFamilies, bySlug, byEnumLower };
}

function loadCatalogTierIndex(options = {}) {
  if (options.availableModels && typeof options.availableModels === 'object') {
    return buildCatalogTierIndex(options.availableModels);
  }
  if (options.catalogPath === null) return null;
  const targetPath =
    typeof options.catalogPath === 'string' && options.catalogPath.trim()
      ? options.catalogPath
      : DEFAULT_MODEL_CATALOG_PATH;
  try {
    if (!existsSync(targetPath)) return null;
    const mtimeMs = statSync(targetPath).mtimeMs;
    if (cachedCatalogIndex && cachedCatalogIndex.path === targetPath && cachedCatalogIndex.mtimeMs === mtimeMs) {
      return cachedCatalogIndex.index;
    }
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8'));
    const index = buildCatalogTierIndex(parsed);
    cachedCatalogIndex = { path: targetPath, mtimeMs, index };
    return index;
  } catch {
    return null;
  }
}

function resolveCatalogTier(m, options = {}) {
  const index = loadCatalogTierIndex(options);
  if (!index) return null;
  const entry = index.bySlug.get(m) || index.byEnumLower.get(m) || null;
  if (entry) {
    if (entry.slug.startsWith('tab_')) return 'dropped';
    const fam = stripTieredFamily(entry.slug);
    if (
      index.flashLiteFamilies.has(fam) ||
      entry.slug.includes('flash-lite') ||
      entry.slug.includes('flash_lite') ||
      /\bnano\b/.test(entry.slug)
    ) {
      return 'flash_lite';
    }
    if (
      index.flashFamilies.has(fam) ||
      entry.slug.includes('haiku') ||
      entry.slug.includes('flash') ||
      entry.slug.includes('hydrogen')
    ) {
      return 'flash';
    }
    const isOpenAi =
      entry.modelProvider === 'MODEL_PROVIDER_OPENAI' ||
      entry.apiProvider.includes('OPENAI') ||
      entry.slug.startsWith('gpt-');
    if (isOpenAi) return 'dropped';
    return 'pro';
  }
  const fam = stripTieredFamily(m);
  if (index.flashLiteFamilies.has(fam)) return 'flash_lite';
  if (index.flashFamilies.has(fam)) return 'flash';
  return null;
}

export function mapClaudeModel(model, options = {}) {
  if (model === undefined || model === null || model === '') return { tier: undefined };
  const m = String(model).trim().toLowerCase();
  if (m === 'inherit' || m === 'pro' || m === 'flash' || m === 'flash_lite') return { tier: m };
  const catalogTier = resolveCatalogTier(m, options);
  if (catalogTier === 'dropped') return { tier: undefined, dropped: true };
  if (catalogTier) return { tier: catalogTier };
  if (
    m.includes('flash-lite') ||
    m.includes('flash_lite') ||
    /\bnano\b/.test(m) ||
    /^model_placeholder_m(?:50|198)$/.test(m)
  ) {
    return { tier: 'flash_lite' };
  }
  if (
    m.includes('haiku') ||
    m.includes('flash') ||
    m.includes('hydrogen') ||
    /^model_placeholder_m(?:18|31[89]|320|322|52[5-8]|53[01]|578|669)$/.test(m)
  ) {
    return { tier: 'flash' };
  }
  if (
    m.includes('opus') ||
    m.includes('sonnet') ||
    m.includes('orchestrator') ||
    /^claude-[a-z0-9._-]+$/.test(m) ||
    /^gemini-\d+(?:\.\d+)?-[a-z0-9._-]+$/.test(m) ||
    /^model_placeholder_m(?:40[0-5]|41[7-9]|427|43[78]|53[2-57]|667|681)$/.test(m)
  ) {
    return { tier: 'pro' };
  }
  return { tier: undefined, dropped: true };
}

// Splits `Read, Bash(git diff:*), Agent(a, b)` on top-level commas only.
export function splitToolList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth = Math.max(0, depth - 1);
    else if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

export function mapClaudeTools(tools) {
  const list = Array.isArray(tools) ? tools : splitToolList(String(tools));
  const mapped = new Set();
  const unmapped = [];
  let mcp = false;
  for (const raw of list.map((t) => String(t).trim()).filter(Boolean)) {
    // `Bash(git diff:*)` -> `Bash`, without a regex that backtracks over "(".
    const paren = raw.indexOf('(');
    const name = (paren > 0 && raw.endsWith(')') ? raw.slice(0, paren) : raw).trim();
    if (name.startsWith('mcp__')) mcp = true;
    else if (AGENT_TOOLS.claude[name]) AGENT_TOOLS.claude[name].forEach((t) => mapped.add(t));
    else unmapped.push(name);
  }
  return { tools: [...mapped].sort(), unmapped, mcp };
}

function agentName(raw, slug, report, item) {
  let name = slugifyName(raw);
  if (RESERVED.has(name)) {
    report.warnings.push(`${item}: "${name}" is a built-in agy agent name; renamed to "${slug}-${name}"`);
    name = `${slug}-${name}`;
  }
  return name;
}

function compileClaudeAgents(pluginDir, { slug, report, taken }) {
  const dir = join(pluginDir, 'agents');
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const item = `agent:${basename(file, '.md')}`;
    let parsed;
    try { parsed = splitFrontmatter(readFileSync(join(dir, file), 'utf8')); } catch (err) {
      report.unported.push({ item, reason: `frontmatter isn't parseable: ${err.message}` });
      rmSync(join(dir, file));
      continue;
    }
    const { data, body } = parsed;
    const name = agentName(data.name ?? basename(file, '.md'), slug, report, item);
    const rawDesc = typeof data.description === 'string' && data.description.trim() ? data.description : `Ported agent ${name}.`;
    const out = { name, description: rewriteRuleVars(rawDesc, item, report) };
    if (data.tools !== undefined && data.tools !== null && data.tools !== '*') {
      const mapped = mapClaudeTools(data.tools);
      out.tools = mapped.tools;
      for (const t of mapped.unmapped) report.unported.push({ item: `${item} tool ${t}`, reason: unmappedToolReason(t) });
      if (mapped.mcp) {
        out.inheritMcp = true;
        report.warnings.push(`${item}: MCP tools in "tools" became inheritMcp: true (all MCP tools, not just the listed ones)`);
      }
    } else {
      out.tools = [...DEFAULT_AGENT_TOOLS];
      out.inheritMcp = true;
    }
    const model = mapClaudeModel(data.model);
    if (model.tier) out.model = model.tier;
    if (model.dropped) report.warnings.push(`${item}: model "${data.model}" has no agy tier; the agent inherits the session's model`);
    const rawTurns = data.max_turns ?? data.maxTurns;
    if (rawTurns !== undefined && rawTurns !== null && rawTurns !== '') {
      const turns = Number.parseInt(String(rawTurns), 10);
      if (Number.isInteger(turns) && turns > 0) out.max_turns = turns;
    }
    const rawPolicy = data.execution_policy ?? data.permissionMode;
    if (typeof rawPolicy === 'string' && rawPolicy.trim()) {
      const mappedPolicy = POLICY_MAP[rawPolicy.trim().toLowerCase()];
      if (mappedPolicy) out.execution_policy = mappedPolicy;
      else report.warnings.push(`${item}: unsupported permissionMode/execution_policy "${rawPolicy}" dropped`);
    }
    const rawSubagents = data.subagents ?? data.agents;
    if (rawSubagents !== undefined && rawSubagents !== null && rawSubagents !== '') {
      const list = Array.isArray(rawSubagents) ? rawSubagents : splitToolList(String(rawSubagents));
      const subs = list.map((s) => slugifyName(String(s).trim())).filter(Boolean);
      if (subs.length) out.subagents = subs;
    }
    out.subagent = true;
    const extra = Object.keys(data).filter((k) => !CLAUDE_AGENT_KEYS.has(k));
    if (extra.length) report.warnings.push(`${item}: dropped ${extra.join(', ')}`);
    rmSync(join(dir, file));
    const cleanBody = rewriteRuleVars(body, item, report);
    writeFileSync(join(dir, `${name}.md`), formatFrontmatter(out, cleanBody));
    taken.add(name);
    report.ported.push(`${item} → agents/${name}.md`);
  }
}

function readModes(srcDir, report) {
  const modes = [];
  for (const file of ['.roomodes', '.kilocodemodes']) {
    const path = join(srcDir, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    let parsed;
    try { parsed = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text); } catch (err) {
      report.unported.push({ item: file, reason: `can't parse: ${err.message}` });
      continue;
    }
    for (const mode of parsed?.customModes ?? []) modes.push({ ...mode, file });
  }
  return modes;
}

function modeRules(srcDir, slug) {
  const texts = [];
  for (const dir of [`.roo/rules-${slug}`, `.kilocode/rules-${slug}`]) {
    const full = join(srcDir, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full).filter((x) => /\.(md|txt)$/i.test(x)).sort()) texts.push(readFileSync(join(full, f), 'utf8').trim());
  }
  for (const f of [`.roorules-${slug}`, `.clinerules-${slug}`]) {
    if (existsSync(join(srcDir, f))) texts.push(readFileSync(join(srcDir, f), 'utf8').trim());
  }
  return texts.filter(Boolean);
}

// Restricted edit groups (`fileRegex`) aren't granted: agy agents can't limit
// edits to a pattern, and widening a mode's permissions silently is worse than
// reporting the gap.
export function mapRooGroups(groups, item, report) {
  const tools = new Set();
  let mcp = false;
  for (const group of Array.isArray(groups) ? groups : []) {
    const [kind, options] = Array.isArray(group) ? group : [group, null];
    if (kind === 'mcp') { mcp = true; continue; }
    if (!ROO_GROUPS[kind]) {
      report.unported.push({ item: `${item} group ${kind}`, reason: kind === 'browser' ? "agy's browser tool names aren't mapped yet" : 'unknown tool group' });
      continue;
    }
    if (options?.fileRegex) {
      report.unported.push({ item: `${item} group ${kind} (${options.fileRegex})`, reason: "agy agents can't restrict edits to a file pattern, so the group isn't granted" });
      continue;
    }
    ROO_GROUPS[kind].forEach((t) => tools.add(t));
  }
  return { tools: [...tools].sort(), mcp };
}

function compileRooModes(pluginDir, { srcDir, slug, report, taken }) {
  const modes = readModes(srcDir, report);
  if (!modes.length) return;
  const dir = join(pluginDir, 'agents');
  mkdirSync(dir, { recursive: true });
  for (const mode of modes) {
    const item = `mode:${mode.slug ?? '?'}`;
    if (typeof mode.slug !== 'string' || typeof mode.roleDefinition !== 'string') {
      report.unported.push({ item, reason: 'a mode needs slug and roleDefinition' });
      continue;
    }
    const name = agentName(mode.slug, slug, report, item);
    if (taken.has(name)) {
      report.unported.push({ item, reason: `an agent named ${name} already exists in the plugin` });
      continue;
    }
    const { tools, mcp } = mapRooGroups(mode.groups, item, report);
    const rawDesc = mode.whenToUse || mode.description || mode.roleDefinition.split(/(?<=\.)\s/)[0];
    const description = rewriteRuleVars(rawDesc, item, report);
    const out = { name, description, tools, ...(mcp ? { inheritMcp: true } : {}), mainAgent: true, subagent: true };
    const rawBody = [`# ${mode.name ?? mode.slug}`, mode.roleDefinition.trim(), mode.customInstructions?.trim(), ...modeRules(srcDir, mode.slug)]
      .filter(Boolean).join('\n\n');
    const body = rewriteRuleVars(rawBody, item, report);
    writeFileSync(join(dir, `${name}.md`), formatFrontmatter(out, `\n${body}\n`));
    taken.add(name);
    report.ported.push(`${item} → agents/${name}.md`);
    for (const f of [`.roo/system-prompt-${mode.slug}`, `.kilocode/system-prompt-${mode.slug}`]) {
      if (existsSync(join(srcDir, f))) {
        report.unported.push({ item: `${item} ${f}`, reason: "it replaces the whole system prompt, which an agy agent can't do; the agent has only the mode's role definition and instructions" });
      }
    }
  }
}

export function compileModes(pluginDir, { srcDir, ecosystems, slug }) {
  const report = { ported: [], unported: [], warnings: [] };
  const taken = new Set();
  if (ecosystems.includes('claude')) compileClaudeAgents(pluginDir, { slug, report, taken });
  if (ecosystems.includes('roo')) compileRooModes(pluginDir, { srcDir, slug, report, taken });
  return report;
}
