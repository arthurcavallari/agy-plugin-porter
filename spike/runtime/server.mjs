// Phase 2.5A spike sidecar: hosts one ported Claude Code mod (engine.mjs) and serves
// its panes to the side-pane view, the hook forwarder (hook.mjs) and the MCP server
// (mcp-entry.mjs). Zero dependencies. Every route but /preload.js needs this server's
// token (in server_info.json) or the host's ANTIGRAVITY_SIDECAR_UI_TOKEN (the view's ?token=).
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from './engine.mjs';
import { PORT } from './locate.mjs';

const HOST = '127.0.0.1';
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim()
  || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', PORT.plugin, PORT.sidecar, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const INFO = join(DATA_DIR, 'server_info.json');
const token = randomBytes(24).toString('hex');
const hostToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null;
const views = new Map(); // conversation id -> Set of SSE responses

function log(event, data = {}) {
  try { appendFileSync(join(DATA_DIR, 'runtime.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n'); } catch {}
}
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: err?.message ?? String(err) }));

const engine = new Engine({
  modUrl: pathToFileURL(join(import.meta.dirname, 'mod', PORT.entry)).href,
  dataDir: DATA_DIR,
  options: { mcpServer: PORT.mcpServer },
  log,
  viewCount: (conv) => views.get(conv)?.size ?? 0,
  emit: (conv, msg) => {
    const text = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of views.get(conv) ?? []) res.write(text);
  },
});

const pill = (title) => `[Open ${title}](sidecar://${PORT.plugin}/${PORT.sidecar}/ui.html)`;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 4e6) raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

// Same lookup as science's server.cjs: ANTIGRAVITY_APP_DATA_DIR, else ~/.gemini/antigravity.
function preloadJs() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() || join(homedir(), '.gemini', 'antigravity');
  try { return readFileSync(join(appDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'), 'utf8'); } catch { return null; }
}

// A view's conversation: a real id, or '' for a new-conversation view (no data shown).
const convOf = (v) => (typeof v === 'string' && v && v !== '_new' ? v : '');

const routes = {
  'GET /ui.html': (req, res) => send(res, 200, readFileSync(join(import.meta.dirname, 'ui.html'), 'utf8'), 'text/html; charset=utf-8'),
  'GET /preload.js': (req, res) => {
    const js = preloadJs();
    return js ? send(res, 200, js, 'application/javascript; charset=utf-8') : send(res, 404, { error: 'sidecar_sdk preload.js not found' });
  },
  'GET /api/events': async (req, res, url) => {
    const conv = convOf(url.searchParams.get('conv'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', mod: PORT.title, conv })}\n\n`);
    if (!conv) return;
    if (!views.has(conv)) views.set(conv, new Set());
    views.get(conv).add(res);
    req.on('close', () => views.get(conv)?.delete(res));
    log('view-open', { conv, views: views.get(conv).size });
    const inst = await engine.get(conv);
    await inst.render();
  },
  // The view reports its workspace, which is the conversation's cwd until a hook says otherwise.
  'POST /api/view': async (req, res, url, body) => {
    const conv = convOf(body.conv);
    if (conv) await engine.get(conv, body.cwd || undefined);
    send(res, 200, { ok: true });
  },
  'POST /api/action': async (req, res, url, body) => {
    const inst = await engine.get(convOf(body.conv));
    await inst.act(String(body.cb), Array.isArray(body.args) ? body.args : []);
    send(res, 200, { ok: true });
  },
  'POST /api/command': async (req, res, url, body) => {
    const inst = await engine.get(convOf(body.conv));
    const r = await engine.runCommand(inst, String(body.command), body.args ?? '', 'view');
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
    const out = await engine.hook(String(body.event), body.payload ?? {});
    log('hook', { hookEvent: body.event, ms: Date.now() - started, path: out.path, stdout: out.stdout,
      conv: body.payload?.conversationId, stepIdx: body.payload?.stepIdx, toolCall: body.payload?.toolCall,
      error: body.payload?.error, keys: Object.keys(body.payload ?? {}) });
    send(res, 200, out);
  },
  'POST /api/mcp': async (req, res, url, body) => {
    if (body.op === 'list') return send(res, 200, { tools: await engine.listTools() });
    const r = await engine.callTool(convOf(body.conv), String(body.name), body.args ?? {});
    log('mcp-call', { name: body.name, conv: body.conv, isError: r.isError });
    const text = r.opened?.length ? `${r.text}\n\nGive the user this link on its own line, exactly: ${pill(r.opened.at(-1))}`.trim() : r.text;
    send(res, 200, { isError: r.isError, text: text || '(done)' });
  },
  'GET /api/debug': (req, res) => send(res, 200, {
    usage: Object.fromEntries(engine.usage),
    instances: [...engine.instances.values()].map(({ inst }) => ({ conv: inst.conv, cwd: inst.cwd, panes: [...inst.panes.keys()], pending: inst.pending.length, views: views.get(inst.conv)?.size ?? 0 })),
  }),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const t = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  // preload.js is the SDK's own public file, loaded by a plain <script> tag.
  const open = req.method === 'GET' && url.pathname === '/preload.js';
  if (!open && (!t || (t !== token && t !== hostToken))) return send(res, 401, { error: 'no valid token' });
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  try {
    await route(req, res, url, req.method === 'POST' ? await readJson(req) : null);
  } catch (err) {
    log('route-error', { path: url.pathname, message: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
});

// Exit once the language server is gone: on Windows a quit orphans every sidecar
// (ui-mods-baseline.md). Same idea as antigravity-sidecar-kit's exitWithLanguageServer.
function watchLanguageServer() {
  const m = /([^/:]+|\[[^\]]+\]):(\d+)/.exec(process.env.ANTIGRAVITY_LS_ADDRESS ?? '');
  if (!m) return;
  let failures = 0;
  setInterval(() => {
    const socket = connect({ host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
    const done = (alive) => {
      socket.destroy();
      failures = alive ? 0 : failures + 1;
      if (failures >= 2) stop('language server gone');
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  }, 5000).unref();
}

const webPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? '', 10);
server.on('error', (err) => { log('listen-error', { message: err.message }); process.exit(1); });
server.listen(Number.isNaN(webPort) ? 0 : webPort, HOST, () => {
  const port = server.address().port;
  writeFileSync(INFO, JSON.stringify({ host: HOST, port, token, pid: process.pid }, null, 2));
  log('start', { port, node: process.version, dataDir: DATA_DIR, mod: PORT.entry, hostToken: Boolean(hostToken) });
  console.log(`[${PORT.plugin}/${PORT.sidecar}] listening on ${HOST}:${port}`);
  watchLanguageServer();
});

// Removes server_info.json only while it is still ours: an orphan from the last app
// session can notice the language server is gone after its replacement wrote the file
// (live: it deleted the new instance's file 2 s after the new one started).
function stop(reason) {
  log('stop', { reason });
  try { if (JSON.parse(readFileSync(INFO, 'utf8')).pid === process.pid) rmSync(INFO, { force: true }); } catch {}
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(sig));
