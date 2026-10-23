// Step 0 PreToolUse hook: forwards the event to the hello sidecar and logs its own
// environment. It ALWAYS prints nothing and exits 0, so it can never block or deny a
// call (agy reads `{}` as a deny and fails the call on any nonzero exit). Only node:
// imports, so a missing file can't crash it before the guards below are in place.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const done = () => process.exit(0);
process.on('uncaughtException', done);
process.on('unhandledRejection', done);
setTimeout(done, 4000).unref();

const PLUGIN = 'porter-step0-hello';
const SECRET = /TOKEN|CSRF|SECRET|KEY|PASS|AUTH|COOKIE|CRED/i;
const SHOWN = /^(ANTIGRAVITY_|CLAUDE_|GEMINI_|NODE_|ELECTRON_|PATH$|PATHEXT$|COMSPEC$)/i;
const event = process.argv[2] || 'PreToolUse';

// Same lookup as science's mcp_entry.cjs (and sidecars/hello/locate.mjs).
function findDataDir() {
  const env = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (env) return { dir: env, from: 'ANTIGRAVITY_EXECUTABLE_DATA_DIR' };
  const gemini = join(homedir(), '.gemini');
  let products = [];
  try { products = readdirSync(gemini, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const product of products) {
    const dir = join(gemini, product, 'sidecar_data', PLUGIN, 'hello', 'data');
    if (existsSync(dir)) return { dir, from: `search:${product}` };
  }
  return { dir: null, from: 'not found' };
}

// Posts to loopback only, whatever server_info.json says, so a rewritten file can't send
// tool calls off this machine.
async function forward(located, payload) {
  let info;
  try { info = JSON.parse(readFileSync(join(located.dir, 'server_info.json'), 'utf8')); } catch { return 'no server_info.json'; }
  const port = Number(info.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad port in server_info.json';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? `delivered to 127.0.0.1:${port}` : `rejected by 127.0.0.1:${port}`;
  } catch (err) {
    return `POST failed: ${err.message}`;
  }
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function whereAgyNode() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['agy-node'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split(/\r?\n/);
  } catch (err) {
    return `not found (exit ${err.status ?? err.code})`;
  }
}

let payload = null;
try { payload = JSON.parse(await readStdin()); } catch {}
const located = findDataDir();
const sidecar = located.dir ? await forward(located, payload) : 'data dir not found';
try {
  const dir = located.dir ?? join(tmpdir(), PLUGIN);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'hook.log'), JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, event,
    tool: payload?.toolCall?.name ?? null, conversationId: payload?.conversationId ?? null,
    cwd: process.cwd(), execPath: process.execPath, dataDir: located, sidecar, whereAgyNode: whereAgyNode(),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => SHOWN.test(k))
      .map(([k, v]) => [k, SECRET.test(k) ? `<redacted, ${v.length} chars>` : v])),
    envNames: Object.keys(process.env).sort(),
  }) + '\n');
} catch {}
done();
