#!/usr/bin/env node
// Assembles the Phase 2.5A spike plugins: spike/mods/<mod> (vendored source + port.json)
// plus spike/runtime -> spike/out/<plugin>/. This is the hand-run stand-in for the
// 2.5B mod compiler. Usage:
//   node spike/build.mjs [--transform esbuild|node] [--esbuild <path to esbuild package>] [mod...]
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform as jsx } from './jsx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = ['server.mjs', 'engine.mjs', 'claude-code.mjs', 'locate.mjs', 'mcp-entry.mjs', 'hook.mjs', 'ui.html'];

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv.splice(i, 2)[1]; };
const mode = opt('--transform', 'esbuild');
const esbuildPath = opt('--esbuild', null);
const mods = argv.length ? argv : readdirSync(join(HERE, 'mods'));

let esbuild;
async function compile(file, source) {
  const ext = extname(file);
  let code = source;
  if (ext === '.ts' || ext === '.tsx') {
    if (mode === 'esbuild') {
      esbuild ??= await import(esbuildPath ? pathToFileURL(join(esbuildPath, 'lib', 'main.js')).href : 'esbuild');
      code = (await esbuild.transform(source, { loader: ext.slice(1), format: 'esm', jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment', target: 'node22' })).code;
    } else {
      code = module.stripTypeScriptTypes(ext === '.tsx' ? jsx(source) : source, { mode: 'strip' });
    }
  }
  // 'claude-code' is the runtime's stand-in; relative .ts/.tsx imports point at the output names.
  return code
    .replace(/(from\s*)(['"])claude-code\2/g, '$1$2../claude-code.mjs$2')
    .replace(/(from\s*['"]\.{1,2}\/[^'"]+)\.(tsx?)(['"])/g, '$1.mjs$3');
}

const outName = (file) => (/\.tsx?$/.test(file) ? file.replace(/\.tsx?$/, '.mjs') : file);

for (const mod of mods) {
  const src = join(HERE, 'mods', mod);
  const port = JSON.parse(readFileSync(join(src, 'port.json'), 'utf8'));
  const out = join(HERE, 'out', port.plugin);
  const side = join(out, 'sidecars', port.sidecar);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(side, 'mod'), { recursive: true });

  for (const f of RUNTIME) cpSync(join(HERE, 'runtime', f), join(side, f));
  writeFileSync(join(side, 'port.json'), JSON.stringify({ ...port, transform: mode }, null, 2));
  for (const f of readdirSync(join(src, 'src'))) {
    writeFileSync(join(side, 'mod', outName(f)), await compile(f, readFileSync(join(src, 'src', f), 'utf8')));
  }
  cpSync(join(src, 'LICENSE'), join(side, 'mod', 'LICENSE'));

  writeFileSync(join(out, 'plugin.json'), JSON.stringify({
    name: port.plugin, displayName: port.displayName, description: port.description, version: '0.0.1', logo: 'logo.svg',
    suggestedPrompts: port.commands.map((c) => `/${c.name}`), disabled: false,
  }, null, 2));
  cpSync(join(HERE, '..', 'test', 'fixtures', 'hello-pane', 'logo.svg'), join(out, 'logo.svg'));

  writeFileSync(join(side, 'sidecar.json'), JSON.stringify({
    command: 'node', args: ['server.mjs'], description: `${port.title}, a Claude Code mod ported by agy-plugin-porter (spike).`,
    display_name: port.title, has_web_ui: true, restart_policy: 'always',
    ui_config: { display_name: port.title, views: [{ entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', path: '/ui.html', title: port.title }] },
  }, null, 2));

  writeFileSync(join(out, 'mcp_config.json'), JSON.stringify({
    mcpServers: { [port.mcpServer]: { command: 'agy-node', args: [`\${PLUGIN_ROOT}/sidecars/${port.sidecar}/mcp-entry.mjs`] } },
  }, null, 2));

  // Hooks run the forwarder on the app's bundled Node. SessionStart, PreInvocation and
  // Stop are flat; tool events are grouped by matcher (agy-baseline.md).
  const cmd = (event, timeout = 10) => ({ type: 'command', command: `agy-node sidecars/${port.sidecar}/hook.mjs ${event}`, timeout });
  const hook = {};
  for (const [event, value] of Object.entries(port.hooks)) {
    hook[event] = typeof value === 'string' ? [{ matcher: value, hooks: [cmd(event)] }] : [cmd(event, 5)];
  }
  writeFileSync(join(out, 'hooks.json'), JSON.stringify({ [`${port.plugin}-mod`]: hook }, null, 2));

  // Commands become skills: agy skills can't run code, so each calls the command's tool.
  for (const c of port.commands) {
    mkdirSync(join(out, 'skills', c.name), { recursive: true });
    writeFileSync(join(out, 'skills', c.name, 'SKILL.md'), [
      '---',
      `name: ${c.name}`,
      `description: Runs the /${c.name} command of the ${port.title} mod. ${c.description} Use when the user types /${c.name} or asks for ${port.title}.`,
      '---',
      '',
      `# /${c.name}`,
      '',
      `This command belongs to ${port.title}, a Claude Code mod ported to Antigravity.`,
      '',
      `1. Call the \`slash_${c.name}\` tool. Pass the text after \`/${c.name}\` as \`args\`${c.argumentHint ? ` (${c.argumentHint})` : ''}, or an empty string.`,
      '2. Reply with the tool\'s text. If it includes a `sidecar://` link, put that link on its own line, exactly as given.',
      '',
    ].join('\n'));
  }
  console.log(`${mod} -> ${out} (${mode})`);
}
