// Compiles Claude Code UI mods into Antigravity plugin sidecars (plan §5, §6). Each
// module listed under a hooks config's "modules" becomes sidecars/<id>/: the porter's
// runtime (scripts/mod-runtime/), the transformed mod and a mod.json with what the
// static scan found. It also writes the mod's MCP server, one skill per command and
// the hooks that forward agy events to the sidecar.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { remapMatcher } from './hook-compiler.mjs';
import { assess, importsOf, scanMod } from './mod-scan.mjs';
import { collectGraph, loadEsbuild, needsTransform, outName, transformFile } from './mod-transform.mjs';
import { slugifyName } from './skill-compiler.mjs';
import { unmappedToolReason } from './tool-map.mjs';

export const RUNTIME_DIR = fileURLToPath(new URL('../scripts/mod-runtime/', import.meta.url));
const LICENSES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'];

const readJsonIf = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

// The agy hooks a scanned mod needs (plan §5.4). Returns {events, unmapped}.
export function modHooks(scan, id) {
  const has = (name) => scan.events.some((e) => e.event === name);
  const cmd = (event, timeout) => ({ type: 'command', command: `agy-node sidecars/${id}/hook.mjs ${event}`, timeout });
  const calls = scan.events.filter((e) => e.event === 'tool.call' && !String(e.matcher.tool ?? '').startsWith('mcp__'));
  const tools = new Set();
  const unmapped = [];
  for (const call of calls) {
    const remap = remapMatcher(call.matcher.tool ?? '*', 'claude');
    unmapped.push(...remap.unmapped);
    for (const t of remap.matcher?.split('|') ?? []) tools.add(t);
  }
  // SessionStart, PreInvocation and Stop are flat; tool events are grouped by matcher.
  const events = { SessionStart: [cmd('SessionStart', 5)] };
  const perTurn = has('turn.start') || has('prompt.context');
  if (perTurn) events.PreInvocation = [cmd('PreInvocation', 5)];
  if (tools.size) {
    const matcher = tools.has('*') ? '*' : [...tools].sort().join('|');
    events.PreToolUse = [{ matcher, hooks: [cmd('PreToolUse', 10)] }];
    events.PostToolUse = [{ matcher, hooks: [cmd('PostToolUse', 10)] }];
  }
  // Stop ends the turn, so the next PreInvocation counts as a turn's first (live, 2.5B)
  if (perTurn || has('turn.complete') || tools.size) events.Stop = [cmd('Stop', 5)];
  return { events, unmapped: [...new Set(unmapped)] };
}

function skillFor(c, { title, slug, id }) {
  return [
    '---',
    `name: ${slugifyName(c.name)}`,
    `description: Runs the /${c.name} command of the ${title} mod.${c.description ? ` ${c.description}` : ''} Use when the user types /${c.name} or asks for ${title}.`.replace(/\s+/g, ' '),
    '---',
    '',
    `# /${c.name}`,
    '',
    `This command belongs to ${title}, a Claude Code mod ported to Antigravity. Its pane is at \`sidecar://${slug}/${id}/ui.html\`.`,
    '',
    `1. Call the \`slash_${c.name}\` tool. Pass the text after \`/${c.name}\` as \`args\`${c.argumentHint ? ` (${c.argumentHint})` : ''}, or an empty string.`,
    "2. Reply with the tool's text. It ends with a `sidecar://` link that opens the pane: put that link on its own line, exactly as given.",
    '',
  ].join('\n');
}

// Writes one compiled mod into pluginDir. Returns its MCP server name, or null.
function emit(pluginDir, { id, files, transformed, scan, verdict, meta, report, item }) {
  const side = join(pluginDir, 'sidecars', id);
  rmSync(side, { recursive: true, force: true });
  mkdirSync(join(side, 'mod'), { recursive: true });
  for (const f of readdirSync(RUNTIME_DIR)) copyFileSync(join(RUNTIME_DIR, f), join(side, f));
  files.forEach((f, i) => { const out = join(side, 'mod', outName(f.rel)); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, transformed[i]); });
  const license = LICENSES.find((l) => existsSync(join(meta.srcDir, l)));
  if (license) copyFileSync(join(meta.srcDir, license), join(side, 'mod', license));

  const hasServer = scan.tools.length > 0 || scan.commands.length > 0;
  const config = readJsonIf(join(pluginDir, 'mcp_config.json')) ?? { mcpServers: {} };
  config.mcpServers ??= {};
  let mcpServer = meta.mcpServer;
  if (hasServer && Object.hasOwn(config.mcpServers, mcpServer)) {
    report.warnings.push(`${item}: an MCP server named ${mcpServer} exists already, so the mod's is ${mcpServer}-mod and its mcp__${mcpServer}__* tool names change`);
    mcpServer = `${mcpServer}-mod`;
  }
  writeJson(join(side, 'mod.json'), {
    plugin: meta.slug, sidecar: id, title: meta.title, pluginName: meta.sourceName, version: meta.version, mcpServer,
    entry: `mod/${outName(meta.entryRel)}`, hasPane: verdict.hasPane, allow: [...scan.calls].sort(), options: meta.options,
    commands: scan.commands, tools: scan.tools, verdict: verdict.verdict, tier: verdict.tier, tierReasons: verdict.tierReasons,
  });
  writeJson(join(side, 'sidecar.json'), {
    command: 'node', args: ['server.mjs'], description: `${meta.title}, a Claude Code mod ported by agy-plugin-porter.`,
    display_name: meta.title, has_web_ui: true, restart_policy: 'always',
    ui_config: { display_name: meta.title, views: [{ entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', path: '/ui.html', title: meta.title }] },
  });
  if (hasServer) {
    config.mcpServers[mcpServer] = { command: 'agy-node', args: [`\${PLUGIN_ROOT}/sidecars/${id}/mcp-entry.mjs`] };
    writeJson(join(pluginDir, 'mcp_config.json'), config);
    report.ported.push(`mcp:${mcpServer}`);
  }
  for (const c of scan.commands) {
    const file = join(pluginDir, 'skills', slugifyName(c.name), 'SKILL.md');
    mkdirSync(dirname(file), { recursive: true });
    try {
      writeFileSync(file, skillFor(c, { title: meta.title, slug: meta.slug, id }), { flag: 'wx' }); // never replaces the plugin's own skill
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      report.warnings.push(`${item}: skills/${slugifyName(c.name)} exists already, so /${c.name} has no skill (the pane's button still runs it)`);
      continue;
    }
    report.ported.push(`command:/${c.name}`);
  }
  const hooks = modHooks(scan, id);
  for (const name of hooks.unmapped) report.unported.push({ item: `${item} tool.call ${name}`, reason: unmappedToolReason(name) });
  const all = readJsonIf(join(pluginDir, 'hooks.json')) ?? {};
  all[`${meta.slug}-mod-${id}`] = hooks.events;
  writeJson(join(pluginDir, 'hooks.json'), all);
}

// A Claude manifest's userConfig defaults, which Claude Code passes to register(on,
// options). Antigravity has no settings UI for them, so the port uses the defaults.
export function userConfigDefaults(userConfig) {
  if (!userConfig || typeof userConfig !== 'object') return {};
  return Object.fromEntries(Object.entries(userConfig).filter(([, v]) => v && typeof v === 'object' && 'default' in v).map(([k, v]) => [k, v.default]));
}

// uiMods: detect()'s list ({path, modules}). Returns {ported, unported, warnings}.
export function compileMods(uiMods, { srcDir, pluginDir, slug, sourceName, title, version, esbuild, options = {} }) {
  const report = { ported: [], unported: [], warnings: [] };
  const entries = uiMods.flatMap((mod) => mod.modules.map((m) => posix.normalize(posix.join(posix.dirname(mod.path.split('#')[0]), String(m)))));
  let esb = esbuild;
  const getEsbuild = () => (esb === undefined ? (esb = loadEsbuild()) : esb);
  const name = sourceName || slug;
  const ids = new Set();
  entries.forEach((entryRel, n) => {
    const item = `ui-mod:${entryRel}`;
    const stem = posix.basename(entryRel).replace(/\.[^.]+$/, '');
    let id = entries.length === 1 ? 'pane' : `pane-${slugifyName(stem)}`;
    if (ids.has(id)) id = `${id}-${n + 1}`;
    ids.add(id);
    let files;
    let transformed;
    try {
      files = collectGraph(srcDir, entryRel);
    } catch (err) {
      report.unported.push({ item, reason: `can't read the mod: ${err.message}` });
      return;
    }
    for (const f of files) rmSync(join(pluginDir, f.rel), { force: true }); // agy staged the raw source
    const scan = scanMod(files.map((f) => ({ path: f.rel, src: f.src })));
    const verdict = assess(scan);
    if (verdict.verdict === 'refused') {
      report.unported.push({ item, reason: `not ported: it ${verdict.refusals.join('; it ')}` });
      return;
    }
    try {
      const tool = needsTransform(files) ? getEsbuild() : null;
      transformed = files.map((f) => transformFile(srcDir, f, tool));
    } catch (err) {
      report.unported.push({ item, reason: err.message });
      return;
    }
    if (entries.length > 1) report.warnings.push(`${item}: one of several mods, so its MCP server is ${name}-${id}`);
    const meta = {
      srcDir, slug, sourceName: name, title: entries.length === 1 ? title || name : `${title || name} (${stem})`,
      version: version ?? '0.0.0', entryRel, mcpServer: entries.length === 1 ? name : `${name}-${id}`, options,
    };
    if (Object.keys(options).length) report.warnings.push(`${item}: userConfig (${Object.keys(options).join(', ')}) uses its defaults; Antigravity has no settings for it`);
    emit(pluginDir, { id, files, transformed, scan, verdict, meta, report, item });
    report.ported.push(`${item} (${verdict.verdict}, sidecar ${id}, sidecar://${slug}/${id}/ui.html)`);
    for (const f of verdict.findings) {
      if (f.level === 'none') report.unported.push({ item: `${item} ${f.item}`, reason: f.reason });
      else report.warnings.push(`${item}: ${f.item}${f.level === 'partial' ? ' is partial' : ''}: ${f.reason}`);
    }
    for (const w of verdict.warnings) report.warnings.push(`${item}: ${w}`);
  });
  if (entries.length) dropModLeftovers(pluginDir, entries, report);
  return report;
}

const CODE = /\.(m?[jt]sx?|cjs|mts)$/;
const walk = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
  const path = rel ? `${rel}/${e.name}` : e.name;
  if (e.isDirectory()) return ['sidecars', 'node_modules', '.git'].includes(path) ? [] : walk(dir, path);
  return [path];
});

// Staged files that only run inside Claude Code: the mod's tests and helpers that
// import 'claude-code' (or 'claude-code/testing') or the mod, and its tsconfig.json. The ported mod lives in
// sidecars/ now, so these would ship raw source nothing can run.
function dropModLeftovers(pluginDir, entries, report) {
  const modFiles = new Set(entries);
  const dropped = [];
  for (const rel of walk(pluginDir).filter((p) => CODE.test(p))) {
    let specs;
    try { specs = importsOf(readFileSync(join(pluginDir, rel), 'utf8')); } catch { continue; }
    const usesMod = specs.some((s) => s === 'claude-code' || s.startsWith('claude-code/') || (/^\.{1,2}\//.test(s) && [...modFiles].some((m) => posix.normalize(posix.join(posix.dirname(rel), s)).replace(/\.[^./]+$/, '') === m.replace(/\.[^./]+$/, ''))));
    if (usesMod) { rmSync(join(pluginDir, rel), { force: true }); dropped.push(rel); }
  }
  if (existsSync(join(pluginDir, 'tsconfig.json'))) { rmSync(join(pluginDir, 'tsconfig.json')); dropped.push('tsconfig.json'); }
  if (dropped.length) report.warnings.push(`dropped files that only run inside Claude Code: ${dropped.sort().join(', ')}`);
}
