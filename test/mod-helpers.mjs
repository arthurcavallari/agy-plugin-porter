// Shared by the UI-mod tests: compiles a mod source into a temp plugin dir, starts its
// sidecar on an ephemeral port with a temp data dir, and plays agy's side (hook
// payloads, MCP calls, the view's SSE stream and clicks).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect } from '../lib/detector.mjs';
import { compileMods } from '../lib/mod-compiler.mjs';
import { loadEsbuild } from '../lib/mod-transform.mjs';

export const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const SPIKE_MODS = fileURLToPath(new URL('../spike/mods/', import.meta.url));
export const hasEsbuild = Boolean(loadEsbuild());
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const tempDir = (prefix = 'porter-mod-') => mkdtempSync(join(tmpdir(), prefix));

export function compileSource(srcDir, { slug, esbuild } = {}) {
  const pluginDir = tempDir('porter-mod-out-');
  const manifest = JSON.parse(readFileSync(join(srcDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const report = compileMods(detect(srcDir).uiMods, {
    srcDir, pluginDir, slug: slug ?? manifest.name, sourceName: manifest.name, title: manifest.displayName, version: manifest.version, esbuild,
  });
  return { pluginDir, report };
}

// A Claude plugin source around one of the vendored stage mods (spike/mods/<mod>/src,
// the upstream files at the commit in its port.json).
export function stageSource(mod) {
  const port = JSON.parse(readFileSync(join(SPIKE_MODS, mod, 'port.json'), 'utf8'));
  const src = tempDir('porter-stage-src-');
  mkdirSync(join(src, '.claude-plugin'));
  writeFileSync(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: port.mcpServer, displayName: port.title, version: '0.0.1' }));
  cpSync(join(SPIKE_MODS, mod, 'src'), join(src, 'hooks'), { recursive: true });
  cpSync(join(SPIKE_MODS, mod, 'LICENSE'), join(src, 'LICENSE'));
  if (readdirSync(join(SPIKE_MODS, mod)).includes('types')) cpSync(join(SPIKE_MODS, mod, 'types'), join(src, 'types'), { recursive: true });
  const entry = readdirSync(join(src, 'hooks')).find((f) => /^register\./.test(f));
  writeFileSync(join(src, 'hooks', 'hooks.json'), JSON.stringify({ modules: [`./${entry}`] }));
  return src;
}

// A free loopback port, as the app picks one for ANTIGRAVITY_SIDECAR_WEB_PORT.
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// Starts sidecars/<id>/server.mjs with a port and UI token chosen here, as the app does,
// and waits for its server_info.json. Returns {child, data, info, call, close}.
export async function startSidecar(pluginDir, id = 'pane') {
  const data = tempDir('porter-mod-data-');
  const info = { port: await freePort(), token: randomBytes(24).toString('hex') };
  const env = {
    ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: data, ANTIGRAVITY_LS_ADDRESS: '',
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(info.port), ANTIGRAVITY_SIDECAR_UI_TOKEN: info.token,
  };
  const child = spawn(process.execPath, [join(pluginDir, 'sidecars', id, 'server.mjs')], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(data, 'server_info.json'))) {
      const call = async (path, body) => {
        const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return res.json();
      };
      return { child, data, env, info, call, pluginDir, id, close: () => child.kill() };
    }
    await wait(50);
  }
  child.kill();
  throw new Error('the sidecar did not start');
}

// The view's SSE stream. `visible` reports the view as seen (as ui.js does).
export async function openView(s, conv, { visible = true } = {}) {
  const msgs = [];
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.info.port}/api/events?conv=${conv}&token=${s.info.token}`, { signal: ac.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { msgs.push(JSON.parse(buf.slice(6, i))); buf = buf.slice(i + 2); }
      }
    } catch {}
  })();
  for (let i = 0; i < 40 && !msgs.length; i++) await wait(25);
  const view = msgs[0]?.view;
  if (visible) await s.call('/api/visibility', { conv, view, visible: true });
  await wait(100);
  return { msgs, view, close: () => ac.abort(), latest: (type) => msgs.filter((m) => m.type === type).at(-1) };
}

// Runs sidecars/<id>/hook.mjs the way agy does, with the payload on stdin.
export function runHook(s, event, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(s.pluginDir, 'sidecars', s.id, 'hook.mjs'), event], { cwd: s.pluginDir, env: s.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

export const walk = (node, fn) => { if (!node || typeof node === 'string') return; fn(node); for (const c of node.children ?? []) walk(c, fn); };
export const textOf = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''));
export const find = (tree, pred) => { let hit; walk(tree, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
