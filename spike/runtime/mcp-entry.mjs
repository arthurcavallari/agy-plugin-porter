// Stdio MCP server for a ported mod: the tools the mod registers with $.tool.register,
// plus one `slash_<name>` tool per $.command.register. Forwards to the sidecar; when the
// sidecar is down it lists port.json's static tools and fails calls with a clear error.
import { createInterface } from 'node:readline';
import { PORT, callSidecar } from './locate.mjs';

const CONVERSATION_META = 'antigravity.google/conversation_id';
const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The sidecar may still be starting when agy asks for the list: retry for ~6 s.
async function listTools() {
  for (let i = 0; i < 12; i++) {
    try { return (await callSidecar('/api/mcp', { op: 'list' }, 3000)).tools; } catch { await wait(500); }
  }
  return PORT.staticTools ?? [];
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return write({ id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: PORT.mcpServer, version: '0.0.1' } } });
    case 'ping':
      return write({ id, result: {} });
    case 'tools/list':
      return write({ id, result: { tools: await listTools() } });
    case 'tools/call': {
      try {
        const r = await callSidecar('/api/mcp', { op: 'call', name: params.name, args: params.arguments ?? {}, conv: params._meta?.[CONVERSATION_META] ?? '' }, 20000);
        return write({ id, result: { content: [{ type: 'text', text: r.text }], isError: Boolean(r.isError) } });
      } catch (err) {
        return write({ id, result: { content: [{ type: 'text', text: `${PORT.title} isn't running, so ${params.name} can't run (${err.message}).` }], isError: true } });
      }
    }
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
