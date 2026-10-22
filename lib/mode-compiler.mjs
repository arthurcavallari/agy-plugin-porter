// Turns Claude Code agents and Roo/Kilo modes into agy agents (agents/<name>.md).
// agy 1.4.x skips a Claude agent outright: `tools: Read, Grep` is a string
// where agy wants a list, and `model: sonnet` isn't an agy model tier. So
// tools are mapped to agy tool names, and models to agy's tiers (pro, flash,
// flash_lite, inherit). Anything that can't be mapped is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { slugifyName } from './skill-compiler.mjs';
import { ROO_GROUPS, TOOLS, unmappedToolReason } from './tool-map.mjs';
import { formatFrontmatter, parseYaml, splitFrontmatter } from './yaml-lite.mjs';

// Names agy reserves for built-in agents (seen in agy 1.4.5's subagent list).
const RESERVED = new Set(['self', 'research', 'image-generator']);
const CLAUDE_AGENT_KEYS = new Set(['name', 'description', 'tools', 'model']);

export function mapClaudeModel(model) {
  if (model === undefined || model === null || model === '') return { tier: undefined };
  const m = String(model).toLowerCase();
  if (m === 'inherit') return { tier: 'inherit' };
  if (m.includes('haiku')) return { tier: 'flash' };
  if (m.includes('opus') || m.includes('sonnet')) return { tier: 'pro' };
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
    const name = raw.replace(/\([\s\S]*\)$/, '').trim();
    if (name.startsWith('mcp__')) mcp = true;
    else if (TOOLS.claude[name]) TOOLS.claude[name].forEach((t) => mapped.add(t));
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
    const out = { name, description: typeof data.description === 'string' && data.description.trim() ? data.description : `Ported agent ${name}.` };
    if (data.tools !== undefined && data.tools !== null && data.tools !== '*') {
      const mapped = mapClaudeTools(data.tools);
      out.tools = mapped.tools;
      for (const t of mapped.unmapped) report.unported.push({ item: `${item} tool ${t}`, reason: unmappedToolReason(t) });
      if (mapped.mcp) {
        out.inheritMcp = true;
        report.warnings.push(`${item}: MCP tools in "tools" became inheritMcp: true (all MCP tools, not just the listed ones)`);
      }
    }
    const model = mapClaudeModel(data.model);
    if (model.tier) out.model = model.tier;
    if (model.dropped) report.warnings.push(`${item}: model "${data.model}" has no agy tier; the agent inherits the session's model`);
    out.subagent = true;
    const extra = Object.keys(data).filter((k) => !CLAUDE_AGENT_KEYS.has(k));
    if (extra.length) report.warnings.push(`${item}: dropped ${extra.join(', ')}`);
    rmSync(join(dir, file));
    writeFileSync(join(dir, `${name}.md`), formatFrontmatter(out, body));
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
    const description = mode.whenToUse || mode.description || mode.roleDefinition.split(/(?<=\.)\s/)[0];
    const out = { name, description, tools, ...(mcp ? { inheritMcp: true } : {}), mainAgent: true, subagent: true };
    const body = [`# ${mode.name ?? mode.slug}`, mode.roleDefinition.trim(), mode.customInstructions?.trim(), ...modeRules(srcDir, mode.slug)]
      .filter(Boolean).join('\n\n');
    writeFileSync(join(dir, `${name}.md`), formatFrontmatter(out, `\n${body}\n`));
    taken.add(name);
    report.ported.push(`${item} → agents/${name}.md`);
  }
}

export function compileModes(pluginDir, { srcDir, ecosystems, slug }) {
  const report = { ported: [], unported: [], warnings: [] };
  const taken = new Set();
  if (ecosystems.includes('claude')) compileClaudeAgents(pluginDir, { slug, report, taken });
  if (ecosystems.includes('roo')) compileRooModes(pluginDir, { srcDir, slug, report, taken });
  return report;
}
