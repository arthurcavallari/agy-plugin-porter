// Stdio MCP server for a ported Claude Code mod: the tools the mod registers with
// $.tool.register, plus one slash_<name> tool per $.command.register. Forwards to the
// sidecar. With the sidecar down it lists what the static scan found (mod.json) and
// fails calls with a clear error.
import { createInterface } from 'node:readline';

import { MOD, callSidecar } from './locate.mjs';

const CONVERSATION_META = 'antigravity.google/conversation_id';
const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN_SCHEMA = { type: 'object', properties: {} };

const scannedTools = () => [
  ...(MOD.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: OPEN_SCHEMA })),
  ...(MOD.commands ?? []).map((c) => ({
    name: `slash_${c.name}`,
    description: `Runs the /${c.name} command: ${c.description ?? ''}`.trim(),
    inputSchema: { type: 'object', properties: { args: { type: 'string' } } },
  })),
];

// The sidecar may still be starting when agy asks for the list: retry for ~6 s.
async function listTools() {
  for (let i = 0; i < 6; i++) {
    try { return (await callSidecar('/api/mcp', { op: 'list' })).tools; } catch { await wait(500); }
  }
  return scannedTools();
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg ?? {};
  switch (method) {
    case 'initialize':
      return write({ id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: MOD.mcpServer, version: MOD.version ?? '0.0.0' } } });
    case 'ping':
      return write({ id, result: {} });
    case 'tools/list':
      return write({ id, result: { tools: await listTools() } });
    case 'tools/call': {
      const conv = params._meta?.[CONVERSATION_META] ?? '';
      try {
        // A mod's own tool may do real work, so calls get longer than the 2 s default.
        const r = await callSidecar('/api/mcp', { op: 'call', name: params.name, args: params.arguments ?? {}, conv }, 20_000);
        return write({ id, result: { content: [{ type: 'text', text: r.text }], isError: Boolean(r.isError) } });
      } catch (err) {
        return write({ id, result: { content: [{ type: 'text', text: `${MOD.title} isn't running, so ${params.name} can't run (${err.message}).` }], isError: true } });
      }
    }
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
