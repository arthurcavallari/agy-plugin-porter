// Normalizes skills in a staged plugin dir so agy loads them under the right
// name: the skills `agy plugin install` made from Claude/Gemini commands
// (no `name`, Claude-only keys, argument placeholders) and native skills. It
// also brings in Codex's `.agents/skills`. `commands/` is removed afterwards:
// plugins don't load it, and agy has already converted it.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatFrontmatter, splitFrontmatter } from './yaml-lite.mjs';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CLAUDE_ONLY_KEYS = ['argument-hint', 'allowed-tools', 'model', 'disable-model-invocation'];
const ARGS = /\$ARGUMENTS\b|\{\{\s*args\s*\}\}|\$[1-9]\b/g;
const SKILL_BYTES = 24_000;

const dirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()) : []);

export function slugifyName(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

function firstLine(body) {
  const line = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l);
  return line ? line.slice(0, 200) : '';
}

// Rewrites one SKILL.md in place. Returns the skill's final folder name.
export function normalizeSkill(skillsDir, folder, report, { fromCommand = false } = {}) {
  const file = join(skillsDir, folder, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  let { data, body, hasFrontmatter } = (() => {
    try { return splitFrontmatter(text); } catch (err) {
      report.warnings.push(`skill:${folder}: frontmatter isn't parseable (${err.message}); rebuilt from the folder name`);
      return { data: {}, body: text.replace(/^---\n[\s\S]*?\n---\n?/, ''), hasFrontmatter: false };
    }
  })();
  const notes = [];
  let name = typeof data.name === 'string' && SKILL_NAME.test(data.name) ? data.name : null;
  let finalFolder = folder;
  if (name && name !== folder) {
    if (!existsSync(join(skillsDir, name))) {
      renameSync(join(skillsDir, folder), join(skillsDir, name));
      finalFolder = name;
    } else {
      notes.push(`renamed from "${name}" to match its folder`);
      name = folder;
    }
  }
  if (!name) name = SKILL_NAME.test(folder) ? folder : slugifyName(folder);
  if (name !== finalFolder && !existsSync(join(skillsDir, name))) {
    // agy names a skill after its frontmatter and wants the folder to match.
    renameSync(join(skillsDir, finalFolder), join(skillsDir, name));
    finalFolder = name;
  } else if (name !== finalFolder) {
    name = finalFolder;
  }
  const out = { name, ...data };
  out.name = name;
  const dropped = CLAUDE_ONLY_KEYS.filter((k) => k in out);
  dropped.forEach((k) => delete out[k]);
  if (dropped.length) notes.push(`dropped ${dropped.join(', ')}`);
  if (typeof out.description !== 'string' || !out.description.trim()) {
    out.description = firstLine(body) || `Ported skill ${name}.`;
    notes.push('description taken from the body');
  }
  const replaced = body.match(ARGS);
  if (replaced) {
    body = body.replace(ARGS, "the user's request");
    notes.push(`replaced ${[...new Set(replaced)].join(', ')} with "the user's request" (skills take no arguments)`);
  }
  if (/^!`|!\{[^}]*\}/m.test(body)) {
    report.warnings.push(`skill:${name}: inline shell execution (!\`…\` / !{…}) isn't supported by agy and is left as text`);
  }
  const rewritten = formatFrontmatter(out, body);
  const changed = !hasFrontmatter || rewritten !== text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (changed) writeFileSync(join(skillsDir, finalFolder, 'SKILL.md'), rewritten);
  if (Buffer.byteLength(body) > SKILL_BYTES) report.warnings.push(`skill:${name}: body is over agy's 24 KB skill limit`);
  if (notes.length) report.warnings.push(`skill:${name}: ${notes.join('; ')}`);
  report.ported.push(fromCommand ? `command → skill:${name}` : `skill:${name}`);
  return finalFolder;
}

// Command skills agy made: Claude's are `<plugin>-cmd-<x>`, Gemini's are named
// after the .toml file. Anything that came from commands/ is "fromCommand".
function commandNames(srcDir) {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else names.add(entry.replace(/\.(md|toml)$/i, ''));
    }
  };
  walk(join(srcDir, 'commands'));
  return names;
}

export function compileSkills(pluginDir, { srcDir, ecosystems }) {
  const report = { ported: [], unported: [], warnings: [] };
  const skillsDir = join(pluginDir, 'skills');
  const commands = commandNames(srcDir);

  if (ecosystems.includes('codex')) {
    for (const folder of dirs(join(srcDir, '.agents/skills'))) {
      if (!existsSync(join(srcDir, '.agents/skills', folder, 'SKILL.md'))) continue;
      if (existsSync(join(skillsDir, folder))) {
        report.unported.push({ item: `skill:${folder}`, reason: 'a skill with this name already exists in the plugin' });
        continue;
      }
      cpSync(join(srcDir, '.agents/skills', folder), join(skillsDir, folder), { recursive: true });
    }
  }

  for (const folder of dirs(skillsDir)) {
    if (!existsSync(join(skillsDir, folder, 'SKILL.md'))) {
      report.warnings.push(`skills/${folder}: no SKILL.md, so agy ignores it`);
      continue;
    }
    const fromCommand = commands.has(folder) || [...commands].some((c) => folder.endsWith(`-cmd-${c}`));
    normalizeSkill(skillsDir, folder, report, { fromCommand });
  }
  if (existsSync(join(pluginDir, 'commands'))) {
    const converted = report.ported.filter((p) => p.startsWith('command')).length;
    if (converted < commands.size) {
      report.unported.push({ item: 'commands/', reason: `${commands.size - converted} command(s) weren't converted to skills by agy` });
    }
    rmSync(join(pluginDir, 'commands'), { recursive: true, force: true });
  }
  return report;
}
