// The Plugin Porter cockpit: a side-pane view where the user previews a port, reads its
// report and installs it after a confirm dialog. Zero dependencies. The view's files
// and the SDK's preload.js are public; every /api route needs this server's token
// (server_info.json) or the host's ANTIGRAVITY_SIDECAR_UI_TOKEN (the view's ?token=).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPreview, installPreview, listPreviews, readPreview } from '../../lib/consent.mjs';
import { removeServerInfoIfOurs, stopOnSignals, watchLanguageServer, writeServerInfo } from '../../scripts/mod-runtime/lifecycle.mjs';

const LOOPBACK = '127.0.0.1';
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim()
  || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-plugin-porter', 'cockpit', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const tokens = [randomBytes(24).toString('hex'), process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN].filter(Boolean);
const STATIC = { '/ui.html': 'text/html', '/ui.js': 'application/javascript', '/ui.css': 'text/css' };
let busy = false;

function log(event, data = {}) {
  try { appendFileSync(join(DATA_DIR, 'cockpit.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n'); } catch {}
}
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: err?.message ?? String(err) }));

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 1e5) raw += c; });
    req.on('end', () => { try { const v = raw ? JSON.parse(raw) : {}; resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); } });
  });
}

// The SDK's preload.js gives the view window.sidecar. Same lookup as the mod runtime.
function preloadJs() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() || join(homedir(), '.gemini', 'antigravity');
  try { return readFileSync(join(appDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'), 'utf8'); } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const summary = (p) => ({ id: p.id, slug: p.slug, source: p.source, path: p.path, tier: p.tier, createdAt: p.createdAt, validated: p.validated });

// One port at a time: each runs git and agy, and the view shows a single report.
async function exclusive(res, work) {
  if (busy) return send(res, 409, { error: 'another port is running; wait for it to finish' });
  busy = true;
  try {
    return send(res, 200, await work());
  } catch (err) {
    return send(res, 400, { error: err.message });
  } finally {
    busy = false;
  }
}

const routes = {
  'GET /api/previews': (req, res) => send(res, 200, { busy, previews: listPreviews().map(summary) }),
  'GET /api/preview': (req, res, url) => {
    const p = readPreview(url.searchParams.get('id'));
    return p ? send(res, 200, p) : send(res, 404, { error: 'no such preview' });
  },
  'POST /api/preview': (req, res, url, body) => exclusive(res, async () => {
    const p = await createPreview({ source: str(body.source), path: str(body.path), slug: str(body.slug) });
    log('preview', { id: p.id, slug: p.slug, tier: p.tier, flags: p.report.flags.length });
    return p;
  }),
  'POST /api/install': (req, res, url, body) => exclusive(res, async () => {
    const r = await installPreview({ previewId: str(body.previewId), acceptedTier: str(body.acceptedTier), acceptedFlags: str(body.acceptedFlags) });
    log('install', { slug: r.slug });
    return r;
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
  log('start', { port, node: process.version, dataDir: DATA_DIR, hostToken: tokens.length > 1 });
  console.log(`[agy-plugin-porter/cockpit] listening on ${LOOPBACK}:${port}`);
  watchLanguageServer(process.env.ANTIGRAVITY_LS_ADDRESS, stop);
});
stopOnSignals(stop);
