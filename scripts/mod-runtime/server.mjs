// Sidecar for a Claude Code mod ported by agy-plugin-porter. Hosts the mod (engine.mjs)
// and serves its panes to the side-pane view, the hook forwarder (hook.mjs) and the
// MCP server (mcp-entry.mjs). Zero dependencies. The view's static files and the SDK's
// preload.js are public; every /api route needs this server's token (server_info.json)
// or the host's ANTIGRAVITY_SIDECAR_UI_TOKEN (the view's ?token=).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Engine } from './engine.mjs';
import { removeServerInfoIfOurs, stopOnSignals, watchLanguageServer, writeServerInfo } from './lifecycle.mjs';
import { LOOPBACK, MOD } from './locate.mjs';

const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim()
  || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', MOD.plugin, MOD.sidecar, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const tokens = [randomBytes(24).toString('hex'), process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN].filter(Boolean);
const views = new Map(); // conversation id -> Map(view id -> {res, visible})
let nextView = 1;

function log(event, data = {}) {
  try { appendFileSync(join(DATA_DIR, 'runtime.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n'); } catch {}
}
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: err?.message ?? String(err) }));

const engine = new Engine({
  mod: MOD,
  modUrl: pathToFileURL(join(import.meta.dirname, MOD.entry)).href,
  dataDir: DATA_DIR,
  log,
  visibleViews: (conv) => [...(views.get(conv)?.values() ?? [])].filter((v) => v.visible).length,
  emit: (conv, msg) => {
    const text = `data: ${JSON.stringify(msg)}\n\n`;
    for (const v of views.get(conv)?.values() ?? []) v.res.write(text);
  },
});

const pill = `[Open ${MOD.title}](sidecar://${MOD.plugin}/${MOD.sidecar}/ui.html)`;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 4e6) raw += c; });
    req.on('end', () => { try { const v = raw ? JSON.parse(raw) : {}; resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); } });
  });
}

// The SDK's preload.js gives the view window.sidecar (live: the host doesn't).
// Same lookup as science's server.cjs: ANTIGRAVITY_APP_DATA_DIR, else ~/.gemini/antigravity.
function preloadJs() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() || join(homedir(), '.gemini', 'antigravity');
  try { return readFileSync(join(appDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'), 'utf8'); } catch { return null; }
}

const STATIC = { '/ui.html': 'text/html', '/ui.js': 'application/javascript', '/ui-draw.js': 'application/javascript' };

// A view's conversation: a real id, or '' for a new-conversation view (no data shown).
const convOf = (v) => (typeof v === 'string' && v && v !== '_new' ? v : '');

const routes = {
  'GET /api/events': async (req, res, url) => {
    const conv = convOf(url.searchParams.get('conv'));
    const id = String(nextView++);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', mod: MOD.title, conv, view: id })}\n\n`);
    if (!conv) return;
    if (!views.has(conv)) views.set(conv, new Map());
    views.get(conv).set(id, { res, visible: false });
    req.on('close', () => views.get(conv)?.delete(id));
    log('view-open', { conv, view: id, views: views.get(conv).size });
    const inst = await engine.get(conv);
    await inst.render();
  },
  // The view reports its workspace, which is the conversation's cwd until a hook says otherwise.
  'POST /api/view': async (req, res, url, body) => {
    const conv = convOf(body.conv);
    if (conv) await engine.get(conv, typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined);
    send(res, 200, { ok: true });
  },
  // visibilityState + IntersectionObserver from the view: hidden copies don't count.
  'POST /api/visibility': async (req, res, url, body) => {
    const v = views.get(convOf(body.conv))?.get(String(body.view));
    if (v) v.visible = body.visible === true;
    send(res, 200, { ok: Boolean(v) });
  },
  'POST /api/action': async (req, res, url, body) => {
    const inst = await engine.get(convOf(body.conv));
    await inst.act(String(body.cb), Array.isArray(body.args) ? body.args : []);
    send(res, 200, { ok: true });
  },
  'POST /api/command': async (req, res, url, body) => {
    const inst = await engine.get(convOf(body.conv));
    const r = await engine.runCommand(inst, String(body.command), typeof body.args === 'string' ? body.args : '', 'view');
    if (r.text) inst.emit({ type: 'toast', text: r.text });
    send(res, 200, r);
  },
  'POST /api/close': async (req, res, url, body) => {
    const inst = await engine.get(convOf(body.conv));
    inst.panes.delete(String(body.id));
    await inst.dispatch('ui.close', { id: String(body.id), origin: { kind: 'person' } }, () => undefined);
    await inst.render();
    send(res, 200, { ok: true });
  },
  'POST /api/hook': async (req, res, url, body) => {
    const started = Date.now();
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const out = await engine.hook(String(body.event), payload);
    log('hook', { hookEvent: body.event, ms: Date.now() - started, path: out.path, stdout: out.stdout,
      conv: payload.conversationId, stepIdx: payload.stepIdx, tool: payload.toolCall?.name, error: payload.error });
    send(res, 200, out);
  },
  'POST /api/mcp': async (req, res, url, body) => {
    if (body.op === 'list') return send(res, 200, { tools: await engine.listTools() });
    const name = String(body.name);
    const r = await engine.callTool(convOf(body.conv), name, body.args && typeof body.args === 'object' ? body.args : {});
    log('mcp-call', { name, conv: body.conv, isError: r.isError });
    // A server can't open a view (live), so command results say how to.
    const link = name.startsWith('slash_') && MOD.hasPane ? `\n\nGive the user this link on its own line, exactly: ${pill}` : '';
    send(res, 200, { isError: r.isError, text: `${r.text || '(done)'}${link}` });
  },
  'GET /api/debug': (req, res) => send(res, 200, {
    instances: [...engine.instances.values()].map(({ inst }) => ({
      conv: inst.conv, cwd: inst.cwd, panes: [...inst.panes.keys()], pending: inst.pending.length,
      views: views.get(inst.conv)?.size ?? 0, visibleViews: engine.visibleViews(inst.conv),
    })),
  }),
};

function tokenOk(t) {
  if (typeof t !== 'string' || !t) return false;
  const given = Buffer.from(t);
  return tokens.some((k) => { const want = Buffer.from(k); return want.length === given.length && timingSafeEqual(want, given); });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${LOOPBACK}`);
  if (req.method === 'GET' && url.pathname === '/preload.js') {
    const js = preloadJs();
    return js ? send(res, 200, js, 'application/javascript; charset=utf-8') : send(res, 404, { error: 'sidecar_sdk preload.js not found' });
  }
  if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
    return send(res, 200, readFileSync(join(import.meta.dirname, url.pathname.slice(1)), 'utf8'), `${STATIC[url.pathname]}; charset=utf-8`);
  }
  if (!tokenOk(req.headers['x-sidecar-token'] || url.searchParams.get('token'))) return send(res, 401, { error: 'no valid token' });
  const key = `${req.method} ${url.pathname}`;
  if (!Object.hasOwn(routes, key)) return send(res, 404, { error: 'not found' });
  try {
    await routes[key](req, res, url, req.method === 'POST' ? await readJson(req) : null);
  } catch (err) {
    log('route-error', { path: url.pathname, message: err.message });
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
});

function stop(reason) {
  log('stop', { reason });
  removeServerInfoIfOurs(DATA_DIR);
  process.exit(0);
}

const webPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? '', 10);
server.on('error', (err) => { log('listen-error', { message: err.message }); process.exit(1); });
server.listen(Number.isNaN(webPort) ? 0 : webPort, LOOPBACK, () => {
  const { port } = server.address();
  writeServerInfo(DATA_DIR, { host: LOOPBACK, port, token: tokens[0] });
  log('start', { port, node: process.version, dataDir: DATA_DIR, mod: MOD.entry, hostToken: tokens.length > 1 });
  console.log(`[${MOD.plugin}/${MOD.sidecar}] listening on ${LOOPBACK}:${port}`);
  watchLanguageServer(process.env.ANTIGRAVITY_LS_ADDRESS, stop);
});
stopOnSignals(stop);
