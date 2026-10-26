// Shared by the sidecar, the MCP server and the hook forwarder. mod.json (next to
// this file, written by agy-plugin-porter) names the plugin, the sidecar and what the
// mod's static scan found. Finds the sidecar's data dir the way Google's science
// plugin does, and calls the sidecar through server_info.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MOD = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
export const LOOPBACK = '127.0.0.1';

// ANTIGRAVITY_EXECUTABLE_DATA_DIR (set for the sidecar only, live), else the first
// ~/.gemini/<product>/sidecar_data/<plugin>/<sidecar>/data that exists.
export function findDataDir() {
  const env = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (env) return env;
  const gemini = join(homedir(), '.gemini');
  let products = [];
  try { products = readdirSync(gemini, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const product of products) {
    const dir = join(gemini, product, 'sidecar_data', MOD.plugin, MOD.sidecar, 'data');
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function readServerInfo(dir = findDataDir()) {
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, 'server_info.json'), 'utf8')); } catch { return null; }
}

// Loopback only, whatever server_info.json says. Re-reads the file on every call:
// a restart changes the port and token, and orphans leave stale files behind (live).
export async function callSidecar(path, body, timeoutMs = 2000) {
  const info = readServerInfo();
  if (!info) throw new Error('sidecar not running (no server_info.json)');
  const port = Number(info.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port in server_info.json');
  if (typeof info.token !== 'string' || !/^[0-9a-f]{16,128}$/.test(info.token)) throw new Error('bad token in server_info.json');
  const res = await fetch(`http://${LOOPBACK}:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the sidecar`);
  return res.json();
}
