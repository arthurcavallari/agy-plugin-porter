// Builds rules/ for agy:
// - CLAUDE.md, GEMINI.md (or gemini-extension.json `contextFileName`) and
//   Codex's AGENTS.md -> rules/AGENTS.md, plain Markdown and always on
// - Cursor .mdc: alwaysApply -> an always_on rule; description only -> a
//   model_decision rule (agy lists it with its description, live-tested);
//   globs or nothing -> a skill, because agy 1.4.5 never applies a plugin's
//   glob or manual rules (live-tested on view and edit, though `agy plugin
//   validate` accepts them)
// - .cursorrules and Roo/Cline/Kilo workspace rules -> always_on rules
// A rule over agy's 24 KB per-file limit is reported unported instead of being
// silently truncated.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { readJson } from './detector.mjs';
import { slugifyName } from './skill-compiler.mjs';
import { formatFrontmatter, splitFrontmatter } from './yaml-lite.mjs';

export const RULE_BYTES = 24_000;
export const RULES_BUDGET_TOKENS = 20_000;

const read = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const isFile = (file) => existsSync(file) && statSync(file).isFile();
const mdFiles = (dir) => (existsSync(dir) && statSync(dir).isDirectory()
  ? readdirSync(dir).filter((f) => /\.(md|mdc|txt)$/i.test(f)).sort().map((f) => join(dir, f))
  : []);

function geminiContextFiles(srcDir) {
  let names = ['GEMINI.md'];
  try {
    const declared = readJson(join(srcDir, 'gemini-extension.json')).contextFileName;
    if (typeof declared === 'string') names = [declared];
    else if (Array.isArray(declared)) names = declared.filter((n) => typeof n === 'string');
  } catch {}
  return names;
}

export function cursorTrigger(data) {
  const globs = Array.isArray(data.globs) ? data.globs.filter(Boolean).join(',') : (typeof data.globs === 'string' ? data.globs.trim() : '');
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (data.alwaysApply === true) return { trigger: 'always_on' };
  if (globs) return { trigger: 'glob', globs, ...(description ? { description } : {}) };
  if (description) return { trigger: 'model_decision', description };
  return { trigger: 'manual' };
}

// A glob-scoped or manual Cursor rule becomes a skill the agent can pull in.
function mdcToSkill(pluginDir, base, trigger, body, item, report) {
  let name = slugifyName(base);
  for (let n = 2; existsSync(join(pluginDir, 'skills', name)); n++) name = `${slugifyName(base)}-${n}`;
  const description = trigger.trigger === 'glob'
    ? `Use when working on files matching ${trigger.globs}.${trigger.description ? ` ${trigger.description}` : ''}`
    : `Use only when the user asks for the "${base}" rule.`;
  mkdirSync(join(pluginDir, 'skills', name), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', name, 'SKILL.md'), formatFrontmatter({ name, description }, `\n${body.trim()}\n`));
  report.ported.push(`${item} → skills/${name}`);
}

export function compileRules(pluginDir, { srcDir, ecosystems }) {
  const report = { ported: [], unported: [], warnings: [] };
  const rulesDir = join(pluginDir, 'rules');
  const outputs = [];
  const used = new Set(existsSync(rulesDir) ? readdirSync(rulesDir).map((f) => f.toLowerCase()) : []);
  const add = (file, content, item, alwaysOn) => {
    if (Buffer.byteLength(content) > RULE_BYTES) {
      report.unported.push({ item, reason: `over agy's 24 KB per-rule limit (${Buffer.byteLength(content)} bytes); agy would truncate it` });
      return;
    }
    let name = file;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = file.replace(/\.md$/, `-${n}.md`);
    used.add(name.toLowerCase());
    outputs.push({ name, content, alwaysOn });
    report.ported.push(`${item} → rules/${name}`);
  };

  // Always-on context files become one rules/AGENTS.md.
  const context = [];
  if (ecosystems.includes('claude')) context.push('CLAUDE.md');
  if (ecosystems.includes('gemini')) context.push(...geminiContextFiles(srcDir));
  if (ecosystems.includes('codex')) context.push('AGENTS.md');
  const sections = [];
  const sources = [];
  for (const name of [...new Set(context)]) {
    const file = join(srcDir, name);
    if (!isFile(file)) continue;
    const text = read(file).trim();
    if (!text) continue;
    if (/^@(?!\[)\S+/m.test(text)) report.warnings.push(`${name}: "@path" imports aren't expanded by agy (it uses @[label](path))`);
    sections.push(text);
    sources.push(name);
  }
  if (sections.length) {
    // Merge with a rules/AGENTS.md the source already shipped.
    if (isFile(join(rulesDir, 'AGENTS.md'))) sections.unshift(read(join(rulesDir, 'AGENTS.md')).trim());
    used.delete('agents.md');
    add('AGENTS.md', `${sections.join('\n\n')}\n`, sources.join(' + '), true);
  }

  if (ecosystems.includes('cursor')) {
    for (const file of mdFiles(join(srcDir, '.cursor/rules')).filter((f) => f.endsWith('.mdc'))) {
      let parsed;
      try { parsed = splitFrontmatter(read(file)); } catch (err) {
        report.unported.push({ item: `.cursor/rules/${basename(file)}`, reason: `frontmatter isn't parseable: ${err.message}` });
        continue;
      }
      const trigger = cursorTrigger(parsed.data);
      const item = `.cursor/rules/${basename(file)} (${trigger.trigger})`;
      if (/^@\S+/m.test(parsed.body)) report.warnings.push(`.cursor/rules/${basename(file)}: "@file" references aren't expanded by agy`);
      if (trigger.trigger === 'glob' || trigger.trigger === 'manual') {
        mdcToSkill(pluginDir, basename(file, '.mdc'), trigger, parsed.body, item, report);
        continue;
      }
      add(`${slugifyName(basename(file, '.mdc'))}.md`, formatFrontmatter(trigger, parsed.body.trim() + '\n'), item, trigger.trigger === 'always_on');
    }
    if (isFile(join(srcDir, '.cursorrules'))) {
      add('cursorrules.md', formatFrontmatter({ trigger: 'always_on' }, `${read(join(srcDir, '.cursorrules')).trim()}\n`), '.cursorrules', true);
    }
  }

  if (ecosystems.includes('roo')) {
    const workspace = [
      ...mdFiles(join(srcDir, '.roo/rules')), ...mdFiles(join(srcDir, '.kilocode/rules')),
      ...mdFiles(join(srcDir, '.clinerules')),
      ...['.roorules', '.kilocoderules', '.clinerules'].map((f) => join(srcDir, f)).filter(isFile),
    ];
    for (const file of workspace) {
      const rel = file.slice(srcDir.length + 1).replace(/\\/g, '/');
      add(`${slugifyName(rel.replace(/\.(md|txt)$/i, ''))}.md`, formatFrontmatter({ trigger: 'always_on' }, `${read(file).trim()}\n`), rel, true);
    }
  }

  // Root context files agy staged are never loaded from there.
  for (const name of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', ...geminiContextFiles(srcDir)]) {
    rmSync(join(pluginDir, name), { force: true });
  }
  if (outputs.length) mkdirSync(rulesDir, { recursive: true });
  for (const { name, content } of outputs) writeFileSync(join(rulesDir, name), content);

  const alwaysOnTokens = Math.ceil(outputs.filter((o) => o.alwaysOn).reduce((n, o) => n + Buffer.byteLength(o.content), 0) / 4);
  if (alwaysOnTokens > RULES_BUDGET_TOKENS) {
    report.warnings.push(`rules: about ${alwaysOnTokens} tokens of always-on rules, over agy's ${RULES_BUDGET_TOKENS}-token budget; agy shows the excess as file pointers`);
  }
  return report;
}
