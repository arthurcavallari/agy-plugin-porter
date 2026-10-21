// Minimal stdio MCP server with one tool, enough for the host to list it.
import { createInterface } from 'node:readline';

const name = process.argv[process.argv.indexOf('--name') + 1] || 'inline-echo';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '0.1.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  } else if (req.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(req.params?.arguments?.text ?? '') }] } });
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
