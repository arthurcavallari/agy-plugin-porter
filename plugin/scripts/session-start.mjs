// SessionStart hook: when a workspace holds a plugin from another tool, tells the agent
// once (per workspace, until what's there changes) that the porter can port it.
// Always prints a JSON object and exits 0: a hook must never break a session.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect } from '../lib/detector.mjs';

const NAMES = { claude: 'a Claude Code plugin', gemini: 'a Gemini CLI extension', cursor: 'Cursor rules', roo: 'Roo/Kilo modes', codex: 'Codex skills' };
const done = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
setTimeout(() => done({}), 3000).unref();

// The app makes ~/.gemini/antigravity/plugin_data/<plugin>/ for each plugin; fall back to tmp.
function stateFile() {
  if (process.env.AGY_PORTER_STATE_DIR) return join(process.env.AGY_PORTER_STATE_DIR, 'session-start.json');
  const pluginData = join(homedir(), '.gemini', 'antigravity', 'plugin_data');
  const dir = existsSync(pluginData) ? join(pluginData, 'agy-plugin-porter') : join(tmpdir(), 'agy-plugin-porter');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'session-start.json');
}

const toPath = (p) => (/^file:/i.test(p) ? fileURLToPath(p) : resolve(p));

function found(dir) {
  const d = detect(dir);
  const kinds = d.manifestless ? [] : d.ecosystems.filter((e) => NAMES[e]);
  return { kinds, mods: d.uiMods.length };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input.replace(/^﻿/, '') || '{}');
  const file = stateFile();
  let seen = {};
  try { seen = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const lines = [];
  for (const ws of (Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []).map(toPath)) {
    if (!existsSync(ws)) continue;
    const { kinds, mods } = found(ws);
    if (!kinds.length) continue;
    const sig = createHash('sha256').update(JSON.stringify([kinds, mods])).digest('hex').slice(0, 16);
    if (seen[ws] === sig) continue;
    seen[ws] = sig;
    const what = kinds.map((k) => NAMES[k]).join(', ') + (mods ? ` (with ${mods} Claude Code UI mod${mods === 1 ? '' : 's'})` : '');
    lines.push(`- ${ws}: ${what}`);
  }
  if (!lines.length) return done({});
  writeFileSync(file, JSON.stringify(seen, null, 2));
  const systemMessage = [
    'The agy-plugin-porter plugin found plugins from other tools in this workspace:',
    ...lines,
    'If the user wants them in Antigravity, follow the port-plugin skill (port_preview, show the report, install only on their yes), or point them to the Plugin Porter cockpit pane. Mention this once; don\'t port anything unasked.',
  ].join('\n');
  done({ injectSteps: [{ systemMessage: { systemMessage } }] });
}

main().catch(() => done({}));
