// Shared by the sidecar, the MCP server and the hook forwarder: finds the sidecar's
// data dir the way science's mcp_entry.cjs does, and calls the sidecar through
// server_info.json. port.json (next to this file) names the plugin and sidecar.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = JSON.parse(readFileSync(new URL('./port.json', import.meta.url), 'utf8'));

// ANTIGRAVITY_EXECUTABLE_DATA_DIR (set for the sidecar only), else the first
// ~/.gemini/<product>/sidecar_data/<plugin>/<sidecar>/data that exists.
export function findDataDir() {
  const env = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (env) return env;
  const gemini = join(homedir(), '.gemini');
  let products = [];
  try { products = readdirSync(gemini, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const product of products) {
    const dir = join(gemini, product, 'sidecar_data', PORT.plugin, PORT.sidecar, 'data');
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function readServerInfo(dir = findDataDir()) {
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, 'server_info.json'), 'utf8')); } catch { return null; }
}

// Loopback only, whatever server_info.json says. Re-reads the file on every call,
// since a restart changes the port and token and orphans leave stale files behind.
export async function callSidecar(path, body, timeoutMs = 2000) {
  const info = readServerInfo();
  if (!info) throw new Error('sidecar not running (no server_info.json)');
  const port = Number(info.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port in server_info.json');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the sidecar`);
  return res.json();
}
