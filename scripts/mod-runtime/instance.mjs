// One Antigravity conversation's copy of a ported Claude Code mod. Each conversation
// gets its own module instance, so module variables and $.state are per conversation,
// like Claude Code's per-session state (live, Phase 2.5A).
import { readFile } from 'node:fs/promises';

import { ELEMENTS, serialize } from './elements.mjs';
import { overwriteOf, toClaudeCall } from './tool-calls.mjs';

const matches = (matcher, e) => !matcher || Object.entries(matcher).every(([k, v]) => e[k] === v);
const quiet = (p) => { p.catch(() => {}); return p; };

// $ methods with no Antigravity equivalent that optional features call: they resolve
// to nothing so the mod keeps working (plan §5.5).
const NO_OPS = new Set(['ui.blit', 'ui.selection', 'session.messages']);
const NO_OP_NOUNS = new Set(['model', 'agent']);

export class Instance {
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
    if (typeof register !== 'function') throw new Error('the mod exports no register function');
    const on = (event, a, b) => {
      const hook = b ? { event, matcher: a, fn: b } : { event, matcher: null, fn: a };
      this.hooks.push(hook);
      // on(...).catch(fn): fn($, e, next) runs when the handler throws.
      const registration = { catch: (fn) => { hook.onError = fn; return registration; } };
      return registration;
    };
    await register(on, this.engine.options);
    await this.dispatch('session.start', { cwd: this.cwd, source: 'startup' }, () => ({}));
  }

  has(event) { return this.hooks.some((h) => h.event === event); }

  // Claude's middleware chain: each handler gets next(), the last next() runs `core`.
  // next() runs the rest once; a second call (from a .catch handler) gets the same result.
  dispatch(event, e, core) {
    const hooks = this.hooks.filter((h) => h.event === event && matches(h.matcher, e));
    const run = (i, input) => {
      if (i >= hooks.length) return Promise.resolve(core(input));
      const hook = hooks[i];
      let result;
      const next = (changed = input) => {
        if (!next.called) { next.called = true; result = run(i + 1, changed); }
        return result;
      };
      next.called = false;
      const frozen = Object.freeze({ ...input });
      return Promise.resolve().then(() => hook.fn(this.$, frozen, next)).catch((err) => {
        if (!hook.onError) throw err;
        this.engine.log('handler-error', { conv: this.conv, event, message: err?.message ?? String(err) });
        return hook.onError(this.$, frozen, next, err);
      });
    };
    return run(0, e);
  }

  emit(msg) { this.engine.emit(this.conv, msg); }
  // Only views the person can see count: Hangar keeps hidden copies of every view.
  get isPlaced() { return this.engine.visibleViews(this.conv) > 0; }

  impl() {
    const inst = this;
    const { store } = this.engine;
    return {
      ui: {
        resolve: () => ELEMENTS,
        invalidate: () => { inst.scheduleRender(); },
        open: async ({ id, title }) => {
          inst.panes.set(id, { id, title: title ?? id });
          inst.scheduleRender();
          return { id, isPlaced: inst.isPlaced };
        },
        close: async ({ id }) => { inst.panes.delete(id); inst.scheduleRender(); return {}; },
        panes: async () => [...inst.panes.values()].map((p) => ({ id: p.id, title: p.title, isPlaced: inst.isPlaced, isShown: inst.isPlaced })),
        status: async (text) => { inst.status = text ?? undefined; inst.emit({ type: 'status', text: text ?? null }); },
        toast: async (text) => { inst.emit({ type: 'toast', text: String(text) }); },
        copy: async ({ text }) => {
          if (!inst.isPlaced) return { isCopied: false, reason: 'no view is open' };
          inst.emit({ type: 'copy', text: String(text) });
          return { isCopied: true };
        },
      },
      // Never drafts or sends into agy's prompt box (it can't): copies, and says so.
      prompt: {
        fill: async ({ text }) => {
          if (!inst.isPlaced) return { isFilled: false, reason: 'no view is open' };
          inst.emit({ type: 'fill', text: String(text) });
          return { isFilled: true };
        },
      },
      state: {
        get: async (key) => inst.state.get(key),
        set: async (key, value) => { inst.state.set(key, value); inst.scheduleRender(); return {}; },
      },
      store: {
        keys: async () => Object.keys(store.data),
        get: async (key) => (Object.hasOwn(store.data, key) ? store.data[key] : undefined),
        set: async (key, value) => { store.data[key] = value; store.save(); },
        delete: async (key) => { delete store.data[key]; store.save(); },
      },
      clock: { now: async () => Date.now() },
      fs: { read: async (path) => readFile(path, 'utf8') },
      session: { cwd: async () => inst.cwd, id: async () => inst.conv },
      command: { register: async (def) => { inst.commands.set(String(def.name), { ...def }); inst.scheduleRender(); return {}; } },
      tool: { register: async (def) => { inst.tools.set(String(def.name), { ...def }); return {}; } },
    };
  }

  // $ exposes only what the static scan found (mod.json `allow`); anything else throws.
  dollar() {
    const impl = this.impl();
    const allow = new Set(this.engine.mod.allow ?? []);
    const plugin = Object.freeze({ name: this.engine.mod.pluginName ?? this.engine.mod.plugin });
    return new Proxy(Object.create(null), {
      get: (_, noun) => {
        if (typeof noun !== 'string' || noun === 'then') return undefined;
        if (noun === 'plugin') {
          if (!allow.has('plugin.name')) throw new Error("$.plugin wasn't in the mod's static scan");
          return plugin;
        }
        return new Proxy(Object.create(null), {
          get: (__, method) => {
            if (typeof method !== 'string' || method === 'then') return undefined;
            const name = `${noun}.${method}`;
            if (!allow.has(name)) throw new Error(`$.${name} wasn't in the mod's static scan`);
            if (NO_OPS.has(name) || NO_OP_NOUNS.has(noun)) return async () => undefined;
            const fn = Object.hasOwn(impl, noun) && Object.hasOwn(impl[noun], method) ? impl[noun][method] : null;
            return fn ?? (() => quiet(Promise.reject(new Error(`$.${name} is not available in the Antigravity port`))));
          },
        });
      },
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

  async renderOne(e, cb) {
    try {
      return { tree: serialize(await this.dispatch('ui.render', e, () => null), cb) };
    } catch (err) {
      return { tree: null, error: err.message };
    }
  }

  async render() {
    const callbacks = new Map();
    const gen = (this.gen = (this.gen ?? 0) + 1);
    let n = 0;
    const cb = (fn) => { const id = `${gen}.${n++}`; callbacks.set(id, fn); return id; };
    const props = { bodyColumns: 80, bodyRows: 40 };
    const panes = [];
    for (const p of this.panes.values()) {
      const e = { component: 'Pane', requestId: p.id, surface: 'desktop', props };
      panes.push({ id: p.id, title: p.title, ...(await this.renderOne(e, cb)) });
    }
    // AbovePrompt and PromptHint draw as a strip above the panes (plan §5.5).
    const strips = [];
    for (const component of ['AbovePrompt', 'PromptHint']) {
      if (!this.hooks.some((h) => h.event === 'ui.render' && h.matcher?.component === component)) continue;
      const r = await this.renderOne({ component, surface: 'desktop', props }, cb);
      if (r.tree) strips.push({ component, tree: r.tree });
    }
    // Keep the previous render's callbacks too, for a click that crossed a redraw.
    this.callbacks = new Map([...(this.lastCallbacks ?? []), ...callbacks]);
    this.lastCallbacks = callbacks;
    this.snapshot = { type: 'state', panes, strips, status: this.status ?? null, commands: [...this.commands.values()] };
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
      return new Promise((resolve) => this.pending.push({ stepIdx: payload.stepIdx, tool: e.tool, at: Date.now(), resolve }));
    };
    const handled = this.dispatch('tool.call', e, core).then((returned) => ({ returned }), (error) => ({ error }));
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), this.engine.preToolWaitMs); });
    const first = await Promise.race([reachedNext, handled, timeout]);
    clearTimeout(timer);
    if (first.e2) {
      const overwrite = overwriteOf(args, e, first.e2);
      return { decision: overwrite ? { decision: 'allow', overwrite } : null, path: overwrite ? 'next(changed)' : 'next' };
    }
    if (first.returned?.deny) return { decision: { decision: 'deny', reason: String(first.returned.deny) }, path: 'deny' };
    if (first.error) this.engine.log('tool-call-error', { conv: this.conv, message: first.error?.message ?? String(first.error) });
    return { decision: null, path: first.timeout ? 'timeout' : first.error ? 'error' : 'returned' };
  }

  // PostToolUse: resume the suspended handler with the same stepIdx (live: Post
  // carries its Pre's stepIdx), else the oldest one for the same tool.
  postToolUse(payload) {
    this.dropStale();
    const { e } = toClaudeCall(payload.toolCall);
    let i = this.pending.findIndex((p) => p.stepIdx !== undefined && p.stepIdx === payload.stepIdx);
    const by = i >= 0 ? 'stepIdx' : 'fifo';
    if (i < 0) i = this.pending.findIndex((p) => p.tool === e.tool);
    if (i < 0) return 'no suspended handler';
    const [p] = this.pending.splice(i, 1);
    const error = payload.error || '';
    p.resolve(error ? { result: undefined, text: error, isError: true, error } : { result: undefined, text: '', isError: false });
    return `resumed (${by})`;
  }

  // Handlers whose PostToolUse never came (a denied call, a lost event).
  dropPending(reason) {
    for (const p of this.pending.splice(0)) p.resolve({ result: undefined, text: reason, isError: true, error: reason });
  }

  dropStale(now = Date.now()) {
    const stale = this.pending.filter((p) => now - p.at > this.engine.pendingMaxMs);
    this.pending = this.pending.filter((p) => !stale.includes(p));
    for (const p of stale) p.resolve({ result: undefined, text: 'no PostToolUse in time', isError: true, error: 'no PostToolUse in time' });
    return stale.length;
  }
}
