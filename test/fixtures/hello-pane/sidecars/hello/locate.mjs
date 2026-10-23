// Shared by the step 0 MCP server and sidecar: finds the sidecar's data dir the way
// science's mcp_entry.cjs does, and talks to the sidecar through server_info.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN = 'porter-step0-hello';
export const SIDECAR = 'hello';
const SECRET = /TOKEN|CSRF|SECRET|KEY|PASS|AUTH|COOKIE|CRED/i;

// ANTIGRAVITY_EXECUTABLE_DATA_DIR, else the first ~/.gemini/<product>/sidecar_data/<plugin>/<sidecar>/data.
export function findDataDir() {
  const env = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (env) return { dir: env, from: 'ANTIGRAVITY_EXECUTABLE_DATA_DIR' };
  const gemini = join(homedir(), '.gemini');
  let products = [];
  try { products = readdirSync(gemini, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const product of products) {
    const dir = join(gemini, product, 'sidecar_data', PLUGIN, SIDECAR, 'data');
    if (existsSync(dir)) return { dir, from: `search:${product}` };
  }
  return { dir: null, from: 'not found' };
}

// Where logs go when the data dir isn't known yet.
export const logDir = (dir) => dir ?? join(tmpdir(), PLUGIN);

export function readServerInfo(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'server_info.json'), 'utf8')); } catch { return null; }
}

// Values of matching env vars, with secret-looking names redacted.
export const pickEnv = (pattern = /^ANTIGRAVITY_/i) => Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => pattern.test(k))
  .map(([k, v]) => [k, SECRET.test(k) ? `<redacted, ${v.length} chars>` : v]));

// Loopback only, whatever server_info.json says, so a rewritten file can't send data off this machine.
export async function callSidecar(info, method, path, body) {
  const port = Number(info.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port in server_info.json');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
