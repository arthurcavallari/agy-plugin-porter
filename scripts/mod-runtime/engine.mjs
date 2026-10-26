// Hosts a ported Claude Code mod for every Antigravity conversation: one Instance
// per conversation, agy hook events mapped to the mod's events (plan §5.4), and the
// MCP side (the mod's $.tool.register tools plus one slash_<name> tool per command).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installJsxGlobals } from './elements.mjs';
import { Instance } from './instance.mjs';

installJsxGlobals();

export class Engine {
  constructor({ mod, modUrl, dataDir, emit, visibleViews, log, preToolWaitMs = 1500, pendingMaxMs = 15 * 60_000 }) {
    Object.assign(this, { mod, modUrl, emit, visibleViews, log, preToolWaitMs, pendingMaxMs });
    this.options = mod.options ?? {};
    this.instances = new Map();
    const file = join(dataDir, 'store.json');
    let data = {};
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    this.store = {
      data: Object.assign(Object.create(null), data),
      save() {
        writeFileSync(`${file}.tmp`, JSON.stringify(this.data, null, 2));
        renameSync(`${file}.tmp`, file);
      },
    };
  }

  // The conversation's instance, loaded on first use. A cwd learned later reruns
  // session.start, as a Claude Code reload does (live, Phase 2.5A).
  async get(conv, cwd) {
    // Hooks report C:\..., the view's workspace URI gives C:/...: use one spelling.
    if (cwd && /^[A-Za-z]:[\\/]/.test(cwd)) cwd = cwd.replace(/\//g, '\\');
    let entry = this.instances.get(conv);
    if (!entry) {
      const inst = new Instance(this, conv, cwd);
      entry = { inst, ready: inst.load() };
      this.instances.set(conv, entry);
      this.log('instance', { conv, cwd: cwd ?? '' });
    }
    await entry.ready;
    const { inst } = entry;
    if (cwd && !inst.cwd) {
      inst.cwd = cwd;
      entry.ready = inst.dispatch('session.start', { cwd, source: 'resume' }, () => ({}));
      await entry.ready;
      inst.scheduleRender();
    }
    return inst;
  }

  // agy hook events, forwarded by hook.mjs. Returns what the hook prints.
  async hook(event, payload) {
    const inst = await this.get(typeof payload?.conversationId === 'string' ? payload.conversationId : '', payload?.workspacePaths?.[0]);
    switch (event) {
      case 'PreInvocation': {
        // PreInvocation runs before every model call: only the first one of a turn
        // starts it, and only that one adds prompt.context.
        if (inst.inTurn) return { stdout: '{}' };
        inst.inTurn = true;
        await inst.dispatch('turn.start', {}, () => undefined);
        return { stdout: await this.promptContext(inst) };
      }
      case 'PreToolUse': {
        const { decision, path } = await inst.preToolUse(payload);
        return { stdout: decision ? JSON.stringify(decision) : '', path };
      }
      case 'PostToolUse':
        return { stdout: '{}', path: inst.postToolUse(payload) };
      case 'Stop':
        inst.dropPending('no PostToolUse before Stop');
        await new Promise((r) => setImmediate(r));
        inst.inTurn = false;
        await inst.dispatch('turn.complete', { agentId: undefined }, () => undefined);
        return { stdout: '{}' };
      default:
        return { stdout: '{}' };
    }
  }

  // Only the systemMessage step is proven live. A step type agy doesn't know ends
  // the whole agent turn (live: hookEphemeralMessage), so nothing else is emitted.
  async promptContext(inst) {
    if (!inst.has('prompt.context')) return '{}';
    const r = await inst.dispatch('prompt.context', { blocks: [] }, (x) => ({ blocks: x.blocks }));
    const text = (Array.isArray(r?.blocks) ? r.blocks : []).map((b) => b?.text).filter((t) => typeof t === 'string' && t).join('\n\n');
    return text ? JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] }) : '{}';
  }

  async listTools() {
    const inst = await this.get('');
    const tools = [];
    for (const t of inst.tools.values()) {
      const full = `mcp__${this.mod.mcpServer}__${t.name}`;
      const d = await inst.dispatch('tool.describe', { tool: full, description: t.description ?? '', inputSchema: t.inputSchema },
        (x) => ({ description: x.description, inputSchema: x.inputSchema }));
      tools.push({ name: t.name, description: d?.description ?? t.description ?? '', inputSchema: d?.inputSchema ?? t.inputSchema ?? { type: 'object', properties: {} } });
    }
    for (const c of inst.commands.values()) tools.push(commandTool(c));
    return tools;
  }

  async callTool(conv, name, args) {
    const inst = await this.get(conv ?? '');
    if (name.startsWith('slash_')) return this.runCommand(inst, name.slice(6), args?.args ?? '', 'mcp');
    const full = `mcp__${this.mod.mcpServer}__${name}`;
    const r = await inst.dispatch('tool.call', { tool: full, ...args }, () => ({ deny: `${name} has no handler in this mod` }));
    if (r?.deny) return { isError: true, text: String(r.deny) };
    return { isError: false, text: typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? null) };
  }

  async runCommand(inst, command, args, from) {
    const r = await inst.dispatch('command.run', { command, args: String(args ?? ''), from }, () => ({ text: `Unknown command /${command}` }));
    return { isError: false, text: typeof r?.text === 'string' ? r.text : '' };
  }
}

export const commandTool = (c) => ({
  name: `slash_${c.name}`,
  description: `Runs the /${c.name} command: ${c.description ?? ''}`.trim(),
  inputSchema: { type: 'object', properties: { args: { type: 'string', description: `What follows /${c.name}${c.argumentHint ? ` (${c.argumentHint})` : ''}; empty for none.` } } },
});
