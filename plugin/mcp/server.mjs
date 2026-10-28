// Stdio MCP server for the porter's own plugin (agy names it agy-plugin-porter_cli):
// port_preview ports a source into a temp folder and returns the report; port_install
// installs a preview, only with the tier and findings digest that preview showed.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { createPreview, installPreview } from '../lib/consent.mjs';

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const { version: VERSION } = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));

const TOOLS = [
  {
    name: 'port_preview',
    description: 'Ports a Claude Code, Gemini CLI, Cursor, Roo/Kilo or Codex plugin into a temporary Antigravity plugin and returns the port report: what was ported, what was not and why, warnings, security-audit flags, the capability tier, and whether `agy plugin validate` passed. Nothing is installed. Show the user the whole report before calling port_install.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'A folder path, or a GitHub repo as owner/repo@<tag or commit>' },
        path: { type: 'string', description: 'Subfolder of the source that holds the plugin (monorepos)' },
        slug: { type: 'string', description: 'Plugin name in Antigravity (default: the source\'s name)' },
      },
      required: ['source'],
    },
  },
  {
    name: 'port_install',
    description: 'Installs a previewed port into Antigravity with `agy plugin install`. Call it only after the user has seen that preview\'s report and said yes. Pass the preview\'s tier as acceptedTier and its flagsDigest as acceptedFlags; a different tier or different findings are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        previewId: { type: 'string' },
        acceptedTier: { type: 'string', enum: ['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL'] },
        acceptedFlags: { type: 'string', description: 'The preview\'s flagsDigest (empty when it had no flags)' },
      },
      required: ['previewId', 'acceptedTier'],
    },
  },
];

function previewText(p) {
  const r = p.report;
  const v = r.validation;
  const lines = [
    `Preview ${p.id}: ${p.slug} (${r.ecosystems.join(' + ') || 'unknown'}), ${p.tier}${r.sourceCommit ? `, source commit ${r.sourceCommit}` : ''}`,
    `Tier because: ${r.tierReasons.join('; ') || 'nothing above telemetry'}`,
    `Ported (${r.ported.length}):`, ...r.ported.map((x) => `  - ${x}`),
    `Not ported (${r.unported.length}):`, ...r.unported.map((u) => `  - ${u.item}: ${u.reason}`),
    `Warnings (${r.warnings.length}):`, ...r.warnings.map((w) => `  - ${w}`),
    `Audit flags (${r.flags.length}):`, ...r.flags.map((f) => `  - [${f.severity}] ${f.kind}${f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`),
    v ? `agy plugin validate: ${v.ok ? 'passed' : `FAILED (${v.errors.length} errors)`}` : 'agy plugin validate: not run (agy isn\'t on PATH), so this preview can\'t be installed',
    '',
    `To install after the user agrees: port_install with previewId "${p.id}", acceptedTier "${p.tier}", acceptedFlags "${p.flagsDigest}". The preview expires in an hour.`,
  ];
  return lines.join('\n');
}

async function call(name, args) {
  if (name === 'port_preview') return previewText(await createPreview(args));
  if (name === 'port_install') {
    const r = await installPreview(args);
    return `Installed ${r.slug}. The user can switch it off in Customizations > Plugins, and should switch it off before \`agy plugin uninstall ${r.slug}\`.\n${r.output}`;
  }
  throw new Error(`unknown tool ${name}`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg ?? {};
  switch (method) {
    case 'initialize':
      return write({ id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agy-plugin-porter', version: VERSION } } });
    case 'ping':
      return write({ id, result: {} });
    case 'tools/list':
      return write({ id, result: { tools: TOOLS } });
    case 'tools/call':
      try {
        return write({ id, result: { content: [{ type: 'text', text: await call(params.name, params.arguments ?? {}) }] } });
      } catch (err) {
        return write({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
      }
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
