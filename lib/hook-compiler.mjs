// Compiles Claude Code / Gemini CLI hook configs into Antigravity's named-hook
// shape. Every handler is routed through scripts/hook-shim.mjs, which looks up
// the original command in scripts/hook-shim.json. The original command never
// goes on agy's command line, so agy's Windows quote mangling can't reach it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUiMod } from './detector.mjs';
import { AGY_TOOLS, TOOLS, unmappedToolReason } from './tool-map.mjs';

export const SHIM_PATH = 'scripts/hook-shim.mjs';
export const SHIM_CONFIG_PATH = 'scripts/hook-shim.json';
const SHIM_SOURCE = fileURLToPath(new URL('../scripts/hook-shim.mjs', import.meta.url));

// Events agy has, keyed by source event name. Matcher-grouped events first.
const GROUPED = new Set(['PreToolUse', 'PostToolUse']);
const EVENTS = {
  claude: { PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', PostToolUseFailure: 'PostToolUse', SessionStart: 'SessionStart', Stop: 'Stop' },
  gemini: { BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', SessionStart: 'SessionStart' },
};
const UNPORTED_EVENTS = {
  UserPromptSubmit: 'agy has no user-prompt event (PreInvocation runs before every model call and carries no prompt)',
  BeforeAgent: 'agy has no user-prompt event (PreInvocation runs before every model call and carries no prompt)',
};

const REGEX_META = /[.*+?^${}()[\]\\]/;

// Rewrites a source matcher into an agy matcher. Returns the agy matcher (or
// null when nothing maps) and the alternatives that didn't map.
export function remapMatcher(matcher, dialect = 'claude') {
  const raw = (matcher ?? '').trim();
  if (raw === '' || raw === '*' || raw === '.*') return { matcher: '*', unmapped: [] };
  const map = TOOLS[dialect];
  const alternatives = raw.includes('(') ? [raw] : raw.split('|').map((a) => a.trim()).filter(Boolean);
  const mapped = new Set();
  const unmapped = [];
  for (const alt of alternatives) {
    if (map[alt]) map[alt].forEach((t) => mapped.add(t));
    else if (AGY_TOOLS.has(alt)) mapped.add(alt);
    else if (!alt.startsWith('mcp__') && REGEX_META.test(alt)) {
      let re;
      try { re = new RegExp(`^(?:${alt})$`); } catch { unmapped.push(alt); continue; }
      const hits = Object.keys(map).filter((name) => re.test(name));
      if (hits.length === 0) unmapped.push(alt);
      hits.forEach((name) => map[name].forEach((t) => mapped.add(t)));
    } else unmapped.push(alt);
  }
  return { matcher: mapped.size ? [...mapped].sort().join('|') : null, unmapped };
}

// Claude SessionStart matchers name the session source; agy only fires on new sessions.
function sessionStartFilter(matcher) {
  const raw = (matcher ?? '').trim();
  if (raw === '' || raw === '*') return { ok: true };
  const sources = raw.split('|').map((s) => s.trim());
  if (!sources.includes('startup')) return { ok: false };
  return { ok: true, dropped: sources.filter((s) => s !== 'startup') };
}

// Seconds the shim gives the script. Claude counts seconds, Gemini milliseconds.
function scriptTimeout(handler, dialect) {
  const t = Number(handler.timeout);
  if (!Number.isFinite(t) || t <= 0) return 60;
  return dialect === 'gemini' ? Math.max(1, Math.ceil(t / 1000)) : t;
}

export function compileHooks(sources, { slug }) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug ?? '')) throw new Error(`invalid slug: ${slug}`);
  const report = { ported: [], unported: [], warnings: [] };
  const events = {};
  const shimHooks = {};
  const counters = {};
  const warnOnce = (text) => { if (!report.warnings.includes(text)) report.warnings.push(text); };

  for (const source of sources) {
    const dialect = source.dialect ?? 'claude';
    if (source.error) {
      report.unported.push({ item: `hooks:${source.path}`, reason: `can't parse: ${source.error}` });
      continue;
    }
    const config = source.config ?? {};
    if (isUiMod(config)) {
      const base = posix.dirname(source.path.split('#')[0]);
      for (const mod of config.modules) {
        const path = posix.normalize(posix.join(base, String(mod)));
        report.unported.push({ item: `ui-mod:${path}`, reason: 'Claude Code UI mods are not ported yet' });
      }
    }
    for (const key of Object.keys(config)) {
      if (!['hooks', 'modules', 'description'].includes(key)) warnOnce(`${source.path}: ignored top-level key "${key}"`);
    }
    const sourceEvents = config.hooks ?? {};
    for (const [sourceEvent, groups] of Object.entries(sourceEvents)) {
      const event = EVENTS[dialect][sourceEvent];
      if (!event) {
        report.unported.push({
          item: `hook:${sourceEvent}`,
          reason: UNPORTED_EVENTS[sourceEvent] ?? `agy has no ${sourceEvent} event`,
        });
        continue;
      }
      (Array.isArray(groups) ? groups : []).forEach((group, gi) => {
        const label = `hook:${sourceEvent}#${gi}${group.matcher ? ` (${group.matcher})` : ''}`;
        let matcher;
        if (GROUPED.has(event)) {
          const remap = remapMatcher(group.matcher, dialect);
          for (const name of remap.unmapped) {
            report.unported.push({ item: `${label} matcher ${name}`, reason: unmappedToolReason(name) });
          }
          if (!remap.matcher) return;
          matcher = remap.matcher;
        } else if (event === 'SessionStart' && dialect === 'claude') {
          const filter = sessionStartFilter(group.matcher);
          if (!filter.ok) {
            report.unported.push({ item: label, reason: 'agy SessionStart fires only on new sessions (startup)' });
            return;
          }
          if (filter.dropped?.length) warnOnce(`${label}: fires on startup only; ${filter.dropped.join(', ')} have no agy equivalent`);
        }
        const handlers = [];
        (Array.isArray(group.hooks) ? group.hooks : []).forEach((handler, hi) => {
          const item = `${label}.${hi}`;
          if ((handler.type ?? 'command') !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) {
            report.unported.push({ item, reason: `only command hooks can be ported (type: ${handler.type ?? 'none'})` });
            return;
          }
          counters[event] = (counters[event] ?? 0) + 1;
          const id = `${event.toLowerCase()}-${counters[event]}`;
          const timeout = scriptTimeout(handler, dialect);
          shimHooks[id] = { event, sourceEvent, dialect, command: handler.command, timeout };
          handlers.push({ type: 'command', command: `node ${SHIM_PATH} --event ${event} --hook ${id}`, timeout: timeout + 5 });
          report.ported.push(item);
        });
        if (handlers.length === 0) return;
        events[event] ??= [];
        // agy rejects the whole file if a non-tool event uses the grouped shape.
        if (GROUPED.has(event)) events[event].push({ matcher, hooks: handlers });
        else events[event].push(...handlers);
        if (event === 'PostToolUse') warnOnce('PostToolUse: agy sends no tool result, so tool_response is empty and block feedback is dropped');
        if (event === 'Stop') warnOnce('Stop: stop_hook_active is approximated from agy\'s executionNum');
      });
    }
  }

  const hasHooks = Object.keys(shimHooks).length > 0;
  return {
    hooks: hasHooks ? { [slug]: events } : null,
    shimConfig: hasHooks ? { version: 1, hooks: shimHooks } : null,
    report,
  };
}

// Writes the compiled hooks into a staged plugin dir: root hooks.json, the shim
// and its config. Removes the foreign-shaped copies agy staged, including a
// UI mod's hooks/hooks.json (UI mods are reported, never copied).
export function writeHookPort(pluginDir, compiled) {
  const rootHooks = join(pluginDir, 'hooks.json');
  const shimTarget = join(pluginDir, SHIM_PATH);
  if (!compiled.hooks) {
    rmSync(rootHooks, { force: true });
  } else {
    if (existsSync(shimTarget) && readFileSync(shimTarget, 'utf8') !== readFileSync(SHIM_SOURCE, 'utf8')) {
      throw new Error(`${SHIM_PATH} already exists in the plugin and isn't the porter's shim`);
    }
    mkdirSync(dirname(shimTarget), { recursive: true });
    copyFileSync(SHIM_SOURCE, shimTarget);
    writeFileSync(join(pluginDir, SHIM_CONFIG_PATH), `${JSON.stringify(compiled.shimConfig, null, 2)}\n`);
    writeFileSync(rootHooks, `${JSON.stringify(compiled.hooks, null, 2)}\n`);
  }
  rmSync(join(pluginDir, 'hooks', 'hooks.json'), { force: true });
}
