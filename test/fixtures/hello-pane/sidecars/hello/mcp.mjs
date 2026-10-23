// Step 0 hello-pane MCP server: stdio, newline-delimited JSON-RPC, zero dependencies.
// Logs every request's _meta, and reaches the sidecar through server_info.json.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PLUGIN, callSidecar, findDataDir, logDir, pickEnv, readServerInfo } from './locate.mjs';

const CONVERSATION_META = 'antigravity.google/conversation_id';
const started = findDataDir();

function log(event, data = {}) {
  try {
    const dir = logDir(findDataDir().dir);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'mcp.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n');
  } catch {}
}

const TOOLS = [
  {
    name: 'hello_status',
    description: "Returns the hello sidecar's server_info.json (token redacted) and its counter.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hello_bump',
    description: "Adds one to the hello sidecar's counter and returns the new value.",
    inputSchema: { type: 'object', properties: {} },
  },
];

// Looks the sidecar up on every call, since it may start (or move ports) after this server.
async function callTool(name, meta) {
  const located = findDataDir();
  const info = located.dir && readServerInfo(located.dir);
  if (!info) return { sidecar: 'not running (no server_info.json)', dataDir: located };
  const serverInfo = { ...info, token: `<redacted, ${String(info.token).length} chars>` };
  try {
    const state = name === 'hello_bump'
      ? await callSidecar(info, 'POST', '/api/click', { source: 'mcp', conversationId: meta?.[CONVERSATION_META] ?? null })
      : await callSidecar(info, 'GET', '/api/state');
    return { serverInfo, dataDir: located, counter: state.counter, lastHook: state.lastHook };
  } catch (err) {
    return { serverInfo, dataDir: located, sidecar: `unreachable: ${err.message}` };
  }
}

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

log('start', {
  cwd: process.cwd(), ppid: process.ppid, execPath: process.execPath, argv: process.argv, node: process.version,
  dataDir: started, env: pickEnv(), path: (process.env.PATH ?? '').split(';'),
});

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  log('request', { method, id: id ?? null, name: params.name ?? null, meta: params._meta ?? null });
  switch (method) {
    case 'initialize':
      return write({ id, result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: PLUGIN, version: '0.0.1' },
      } });
    case 'ping':
      return write({ id, result: {} });
    case 'tools/list':
      return write({ id, result: { tools: TOOLS } });
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params.name)) return write({ id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
      const out = await callTool(params.name, params._meta);
      return write({ id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
    }
    default:
      // Notifications (no id) need no answer.
      if (id !== undefined) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
