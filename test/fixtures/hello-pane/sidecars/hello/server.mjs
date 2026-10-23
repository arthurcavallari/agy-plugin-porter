// Step 0 hello-pane sidecar: logs what Antigravity hands a third-party plugin sidecar,
// and serves a counter view, SSE, a click API and a hook sink. Zero dependencies.
// Every route needs a token: this server's own (in server_info.json, for hooks and
// MCP) or the host's ANTIGRAVITY_SIDECAR_UI_TOKEN (passed to the view as ?token=).
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, SIDECAR, pickEnv } from './locate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const envDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
const DATA_DIR = envDir || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', PLUGIN, SIDECAR, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const INFO = join(DATA_DIR, 'server_info.json');
const token = randomBytes(24).toString('hex');
const hostToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null;
const state = { counter: 0, lastHook: null, pid: process.pid, startedAt: new Date().toISOString() };
const clients = new Set();

function log(event, data = {}) {
  try {
    appendFileSync(join(DATA_DIR, 'hello.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n');
  } catch {}
}

const scrub = (s) => (s ? String(s).replace(/([?&]token=)[^&#]*/gi, '$1<redacted>') : null);
const authOf = (t) => (t && t === token ? 'server' : t && t === hostToken ? 'host' : null);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 1e6) raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ unparsed: raw.slice(0, 2000) }); } });
  });
}

function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const c of clients) c.write(msg);
}

// Same lookup as science's server.cjs: ANTIGRAVITY_APP_DATA_DIR, else ~/.gemini/antigravity.
function preloadJs() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() || join(homedir(), '.gemini', 'antigravity');
  try { return readFileSync(join(appDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'), 'utf8'); } catch { return null; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const auth = authOf(req.headers['x-sidecar-token'] || url.searchParams.get('token'));
  log('request', {
    method: req.method, path: url.pathname, query: scrub(url.search), auth,
    origin: req.headers.origin ?? null, referer: scrub(req.headers.referer), fetchDest: req.headers['sec-fetch-dest'] ?? null,
  });
  if (!auth) {
    const keys = [...url.searchParams.keys()].join(', ') || '(none)';
    return send(res, 401, `401: no valid token. Query keys received: ${keys}\n`, 'text/plain; charset=utf-8');
  }
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /ui.html':
      return send(res, 200, readFileSync(join(HERE, 'ui.html'), 'utf8'), 'text/html; charset=utf-8');
    case 'GET /preload.js': {
      const js = preloadJs();
      return js ? send(res, 200, js, 'application/javascript; charset=utf-8') : send(res, 404, { error: 'sidecar_sdk preload.js not found' });
    }
    case 'GET /api/state':
      return send(res, 200, { ...state, dataDir: DATA_DIR });
    case 'GET /api/events':
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    case 'POST /api/click': {
      const body = await readJson(req);
      state.counter += 1;
      log('click', { source: body.source ?? 'ui', conversationId: body.conversationId ?? null, counter: state.counter });
      broadcast();
      return send(res, 200, state);
    }
    case 'POST /api/hook': {
      const { event, payload } = await readJson(req);
      state.lastHook = {
        at: new Date().toISOString(), event: event ?? null, tool: payload?.toolCall?.name ?? null,
        command: payload?.toolCall?.args?.CommandLine ?? null, conversationId: payload?.conversationId ?? null, stepIdx: payload?.stepIdx ?? null,
      };
      log('hook', { event, payload });
      broadcast();
      return send(res, 200, { ok: true });
    }
    case 'POST /api/report':
      log('ui-report', await readJson(req));
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'not found' });
  }
});

const webPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? '', 10);
server.on('error', (err) => { log('listen-error', { message: err.message }); process.exit(1); });
server.listen(Number.isNaN(webPort) ? 0 : webPort, HOST, () => {
  const port = server.address().port;
  writeFileSync(INFO, JSON.stringify({ host: HOST, port, token, pid: process.pid }, null, 2));
  log('start', {
    cwd: process.cwd(), ppid: process.ppid, execPath: process.execPath, argv: process.argv, node: process.version,
    port, portFrom: Number.isNaN(webPort) ? 'ephemeral' : 'ANTIGRAVITY_SIDECAR_WEB_PORT',
    dataDir: DATA_DIR, dataDirFrom: envDir ? 'ANTIGRAVITY_EXECUTABLE_DATA_DIR' : 'fallback', hostToken: Boolean(hostToken),
    env: pickEnv(), otherEnv: pickEnv(/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/), path: (process.env.PATH ?? '').split(';'),
  });
  console.log(`[${PLUGIN}/${SIDECAR}] listening on ${HOST}:${port}, data dir ${DATA_DIR}`);
});

// Like science's server: drop server_info.json on the way out so callers fail fast.
function stop(signal) {
  log('stop', { signal });
  rmSync(INFO, { force: true });
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(sig));
process.on('exit', (code) => log('exit', { code }));
