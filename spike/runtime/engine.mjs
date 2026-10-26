// Phase 2.5A spike runtime: runs a Claude Code mod's register(on) against a stand-in
// `$`, one module instance per Antigravity conversation (Claude Code's state is per
// session). Hand-written for the spike; plan §5 describes the design.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// JSX globals (classic runtime: the mods compile against bare h and Fragment).
const normalize = (c) => (c == null || typeof c === 'boolean' ? [] : Array.isArray(c) ? c.flatMap(normalize)
  : typeof c === 'number' ? [String(c)] : [c]);
const element = (type, props) => {
  const { children, ...rest } = props ?? {};
  return { type, props: rest, children: normalize(children) };
};
globalThis.h = (tag, props, ...children) => {
  const all = { ...(props ?? {}) };
  if (children.length) all.children = children;
  return typeof tag === 'function' ? tag(all) : element(String(tag), all);
};
globalThis.Fragment = (props) => element('Box', { flexDirection: 'column', ...props });

// $.ui.resolve(e): every element name is a constructor; the view decides how to draw it.
const ELEMENTS = new Proxy({}, { get: (_, name) => (typeof name === 'string' ? (props) => element(name, props) : undefined) });

// agy tool calls -> Claude tool.call input. Arg names: the CLI's (live, agy-baseline.md)
// plus the desktop app's, which the spike logs and checks.
const AGY_TO_CLAUDE = {
  run_command: 'Bash', view_file: 'Read', read_file: 'Read', write_to_file: 'Write', write_file: 'Write',
  replace_file_content: 'Edit', edit_file: 'Edit', multi_replace_file_content: 'Edit', grep_search: 'Grep',
  find_by_name: 'Glob', list_dir: 'LS', read_url_content: 'WebFetch', search_web: 'WebSearch',
};
const ARG_NAMES = {
  CommandLine: 'command', Path: 'file_path', TargetFile: 'file_path', AbsolutePath: 'file_path',
  Content: 'content', CodeContent: 'content', Target: 'old_string', Replacement: 'new_string',
};
export function toClaudeCall(toolCall) {
  const args = typeof toolCall?.args === 'string' ? safeJson(toolCall.args) : toolCall?.args ?? {};
  const e = { tool: AGY_TO_CLAUDE[toolCall?.name] ?? toolCall?.name ?? '' };
  for (const [k, v] of Object.entries(args)) e[ARG_NAMES[k] ?? k] = v;
  const chunks = args.ReplacementChunks;
  if (Array.isArray(chunks) && chunks.length) {
    e.old_string = chunks.map((c) => c.TargetContent ?? '').join('\n…\n');
    e.new_string = chunks.map((c) => c.ReplacementContent ?? '').join('\n…\n');
  }
  return { e, args };
}
// The args a rewritten input changed, under their agy names (an agy `overwrite`).
function overwriteOf(args, before, after) {
  const out = {};
  for (const k of Object.keys(args)) {
    const name = ARG_NAMES[k] ?? k;
    if (after[name] !== before[name]) out[k] = after[name];
  }
  return Object.keys(out).length ? out : null;
}
function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }

const matches = (matcher, e) => !matcher || Object.entries(matcher).every(([k, v]) => e[k] === v);
const quiet = (p) => { p.catch(() => {}); return p; };
const PRE_TOOL_WAIT_MS = 8000;

class Instance {
  constructor(engine, conv, cwd) {
    Object.assign(this, { engine, conv, cwd: cwd ?? '' });
    this.hooks = [];
    this.state = new Map();
    this.panes = new Map();
    this.commands = new Map();
    this.tools = new Map();
    this.callbacks = new Map();
    this.pending = [];
    this.inTurn = false;
    this.status = undefined;
    this.renderQueued = false;
    this.$ = this.dollar();
  }

  async load() {
    const mod = await import(`${this.engine.modUrl}?conv=${encodeURIComponent(this.conv || '_none')}`);
    const register = mod.register ?? mod.default?.register ?? mod.default;
    const on = (event, a, b) => this.hooks.push(b ? { event, matcher: a, fn: b } : { event, matcher: null, fn: a });
    await register(on, this.engine.options);
    await this.dispatch('session.start', { cwd: this.cwd, source: 'startup' }, () => ({}));
  }

  has(event) { return this.hooks.some((h) => h.event === event); }

  // Claude's middleware chain: each hook gets next(), the last next() runs `core`.
  dispatch(event, e, core) {
    const hooks = this.hooks.filter((h) => h.event === event && matches(h.matcher, e));
    const run = (i, input = e) => (i < hooks.length
      ? Promise.resolve(hooks[i].fn(this.$, Object.freeze({ ...input }), (next = input) => run(i + 1, next)))
      : Promise.resolve(core(input)));
    this.engine.used(`event:${event}`, true);
    return run(0);
  }

  emit(msg) { this.engine.emit(this.conv, msg); }
  get viewOpen() { return this.engine.viewCount(this.conv) > 0; }

  dollar() {
    const inst = this;
    const store = this.engine.store;
    const impl = {
      ui: {
        resolve: () => ELEMENTS,
        open: async ({ id, title }) => {
          inst.panes.set(id, { id, title: title ?? id });
          inst.scheduleRender();
          return { id, isPlaced: inst.viewOpen };
        },
        close: async ({ id }) => { inst.panes.delete(id); inst.scheduleRender(); return {}; },
        panes: async () => [...inst.panes.values()].map((p) => ({ id: p.id, title: p.title, isPlaced: inst.viewOpen, isShown: inst.viewOpen })),
        invalidate: () => { inst.scheduleRender(); },
        status: async (text) => { inst.status = text; inst.emit({ type: 'status', text: text ?? null }); },
        toast: async (text) => { inst.emit({ type: 'toast', text: String(text) }); },
        copy: async ({ text }) => {
          inst.emit({ type: 'copy', text: String(text) });
          return inst.viewOpen ? { isCopied: true } : { isCopied: false, reason: 'no view is open' };
        },
      },
      prompt: {
        // Never drafts or sends into agy's prompt box (it can't): copies, and says so.
        fill: async ({ text }) => {
          inst.emit({ type: 'fill', text: String(text) });
          return inst.viewOpen ? { isFilled: true } : { isFilled: false, reason: 'no view is open' };
        },
      },
      state: {
        get: async (key) => inst.state.get(key),
        set: async (key, value) => { inst.state.set(key, value); inst.scheduleRender(); return {}; },
      },
      store: {
        keys: async () => Object.keys(store.data),
        get: async (key) => store.data[key],
        set: async (key, value) => { store.data[key] = value; store.save(); },
        delete: async (key) => { delete store.data[key]; store.save(); },
      },
      clock: { now: async () => Date.now() },
      fs: { read: async (path) => readFile(path, 'utf8') },
      session: { cwd: async () => inst.cwd, id: async () => inst.conv },
      command: { register: async (def) => { inst.commands.set(def.name, { ...def }); return {}; } },
      tool: { register: async (def) => { inst.tools.set(def.name, { ...def }); return {}; } },
    };
    // Every $.noun.method a mod touches is counted for the scorecard; missing ones reject.
    return new Proxy({}, {
      get: (_, noun) => (typeof noun !== 'string' ? undefined : new Proxy({}, {
        get: (__, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          const fn = impl[noun]?.[method];
          inst.engine.used(`$.${noun}.${method}`, Boolean(fn));
          return fn ?? (() => quiet(Promise.reject(new Error(`$.${noun}.${method} is not available in the Antigravity port`))));
        },
      })),
    });
  }

  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render().catch((err) => this.engine.log('render-error', { conv: this.conv, message: err.message }));
    }, 0);
  }

  async render() {
    const callbacks = new Map();
    const gen = (this.gen = (this.gen ?? 0) + 1);
    let n = 0;
    const panes = [];
    for (const p of this.panes.values()) {
      const e = { component: 'Pane', requestId: p.id, surface: 'desktop', props: { bodyColumns: 80, bodyRows: 40 } };
      try {
        const tree = await this.dispatch('ui.render', e, () => null);
        panes.push({ id: p.id, title: p.title, tree: serialize(tree, (fn) => { const id = `${gen}.${n++}`; callbacks.set(id, fn); return id; }) });
      } catch (err) {
        panes.push({ id: p.id, title: p.title, tree: null, error: err.message });
      }
    }
    // Keep the previous render's callbacks too, for a click that crossed a redraw.
    this.callbacks = new Map([...(this.lastCallbacks ?? []), ...callbacks]);
    this.lastCallbacks = callbacks;
    this.snapshot = { type: 'state', panes, status: this.status ?? null, commands: [...this.commands.values()] };
    this.emit(this.snapshot);
  }

  async act(id, args) {
    const fn = this.callbacks.get(id);
    if (!fn) throw new Error('that control is gone; the pane was redrawn');
    await fn(...args);
    this.scheduleRender();
  }

  // PreToolUse: run the tool.call chain until a handler returns or calls next().
  // A handler waiting in next() resumes at PostToolUse (plan §5.2).
  async preToolUse(payload) {
    const { e, args } = toClaudeCall(payload.toolCall);
    let reached;
    const reachedNext = new Promise((r) => { reached = r; });
    const core = (e2) => {
      reached({ e2 });
      return new Promise((resolve) => this.pending.push({ stepIdx: payload.stepIdx, tool: e.tool, resolve }));
    };
    const handled = this.dispatch('tool.call', e, core).then((returned) => ({ returned }), (error) => ({ error }));
    const timeout = new Promise((r) => setTimeout(() => r({ timeout: true }), PRE_TOOL_WAIT_MS).unref());
    const first = await Promise.race([reachedNext, handled, timeout]);
    if (first.e2) {
      const overwrite = overwriteOf(args, e, first.e2);
      return { decision: overwrite ? { decision: 'allow', overwrite } : null, path: overwrite ? 'next(changed)' : 'next' };
    }
    if (first.returned?.deny) return { decision: { decision: 'deny', reason: String(first.returned.deny) }, path: 'deny' };
    if (first.error) this.engine.log('tool-call-error', { conv: this.conv, message: first.error.message });
    return { decision: null, path: first.timeout ? 'timeout' : first.error ? 'error' : 'returned' };
  }

  // PostToolUse: resume the matching suspended handler. stepIdx first, then the
  // oldest pending call for the same tool.
  postToolUse(payload) {
    const { e } = toClaudeCall(payload.toolCall);
    let i = this.pending.findIndex((p) => p.stepIdx !== undefined && p.stepIdx === payload.stepIdx);
    const by = i >= 0 ? 'stepIdx' : 'fifo';
    if (i < 0) i = this.pending.findIndex((p) => p.tool === e.tool);
    if (i < 0) return 'no suspended handler';
    const [p] = this.pending.splice(i, 1);
    const error = payload.error || '';
    p.resolve(error ? { result: undefined, text: error, isError: true } : { result: undefined, text: '' });
    return `resumed (${by})`;
  }

  // Handlers whose PostToolUse never came (a denied call, a lost event) end here.
  dropPending(reason) {
    for (const p of this.pending.splice(0)) p.resolve({ result: undefined, text: reason, isError: true });
  }
}

const serialize = (node, cb) => {
  if (node == null || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return { type: 'Box', props: { flexDirection: 'column' }, children: node.map((c) => serialize(c, cb)).filter((c) => c !== null) };
  const props = {};
  for (const [k, v] of Object.entries(node.props ?? {})) props[k] = typeof v === 'function' ? { $cb: cb(v) } : v;
  return { type: node.type, props, children: (node.children ?? []).map((c) => serialize(c, cb)).filter((c) => c !== null) };
};

export class Engine {
  constructor({ modUrl, dataDir, options = {}, emit, viewCount, log }) {
    Object.assign(this, { modUrl, options, emit, viewCount, log });
    this.instances = new Map();
    this.usage = new Map();
    const file = join(dataDir, 'store.json');
    let data = {};
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    this.store = {
      data,
      save() {
        writeFileSync(`${file}.tmp`, JSON.stringify(this.data, null, 2));
        renameSync(`${file}.tmp`, file);
      },
    };
  }

  used(name, available) {
    const u = this.usage.get(name) ?? { calls: 0, available };
    u.calls += 1;
    this.usage.set(name, u);
  }

  // The conversation's instance, loaded on first use. A cwd learned later reruns
  // session.start, as a Claude Code reload does.
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
    const inst = await this.get(payload?.conversationId ?? '', payload?.workspacePaths?.[0]);
    switch (event) {
      case 'PreInvocation': {
        if (!inst.inTurn) {
          inst.inTurn = true;
          await inst.dispatch('turn.start', {}, () => undefined);
        }
        if (!inst.has('prompt.context')) return { stdout: '{}' };
        const r = await inst.dispatch('prompt.context', { blocks: [] }, (x) => ({ blocks: x.blocks }));
        const text = (r?.blocks ?? []).map((b) => b.text).filter(Boolean).join('\n\n');
        // Only the systemMessage step is proven live (SessionStart). An injected step agy
        // doesn't recognize ends the whole agent turn (live: hookEphemeralMessage).
        return { stdout: text ? JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] }) : '{}' };
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

  // MCP: tools the mod registered, plus one tool per slash command.
  async listTools() {
    const inst = await this.get('');
    const tools = [];
    for (const t of inst.tools.values()) {
      const full = `mcp__${this.options.mcpServer}__${t.name}`;
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
    const full = `mcp__${this.options.mcpServer}__${name}`;
    const r = await inst.dispatch('tool.call', { tool: full, ...args }, () => ({ deny: `${name} has no handler in this mod` }));
    if (r?.deny) return { isError: true, text: String(r.deny) };
    return { isError: false, text: typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? null) };
  }

  async runCommand(inst, command, args, from) {
    const before = new Set(inst.panes.keys());
    const r = await inst.dispatch('command.run', { command, args: String(args ?? ''), from }, () => ({ text: `Unknown command /${command}` }));
    const opened = [...inst.panes.values()].filter((p) => !before.has(p.id) || from === 'mcp');
    return { isError: false, text: r?.text ?? '', opened: opened.map((p) => p.title) };
  }
}

const commandTool = (c) => ({
  name: `slash_${c.name}`,
  description: `Runs the /${c.name} command: ${c.description ?? ''}`.trim(),
  inputSchema: { type: 'object', properties: { args: { type: 'string', description: `What follows /${c.name}${c.argumentHint ? ` (${c.argumentHint})` : ''}; empty for none.` } } },
});
