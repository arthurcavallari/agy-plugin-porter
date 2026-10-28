// Static scan of a Claude Code UI mod. Claude Code reads `on(...)` and
// `$.noun.method(...)` literally from a mod's source (blast-radius's header), so the
// porter can list a mod's events, host calls, commands, tools and render sites
// without running it, then judge how well it ports (plan §5.5, §5.6).
import { blank, closeOf, literalAt, objectFields } from './mod-lexer.mjs';

// Antigravity's side of each Claude event (plan §5.4, scorecard in ui-mods-baseline.md).
const EVENTS = {
  'session.start': null,
  'turn.start': null,
  'turn.complete': null,
  'tool.call': null,
  'ui.render': null,
  'command.run': ['partial', 'a generated skill calls its slash_<name> tool (one model turn), plus a button in the pane'],
  'tool.describe': ['partial', 'applied once at tools/list; isDeferred has no equivalent'],
  'prompt.context': ['partial', 'added once per turn as a systemMessage step, which shows in the transcript'],
  'ui.close': ['partial', "only the pane's own × reports a close; closing Antigravity's pane tab sends nothing"],
  'prompt.submit': ['none', 'agy has no user-prompt event'],
  'prompt.compose': ['none', 'agy has no user-prompt event'],
};
const WORKS = new Set(['ui.resolve', 'ui.invalidate', 'ui.close', 'ui.toast', 'ui.status', 'ui.copy', 'store.keys', 'store.get',
  'store.set', 'store.delete', 'state.get', 'state.set', 'clock.now', 'fs.read', 'session.cwd', 'session.id',
  'command.register', 'tool.register', 'plugin.name']);
const PARTIAL = {
  'ui.open': 'only the person can show the pane, through a sidecar:// link or its tab',
  'ui.panes': 'isPlaced and isShown count only views the person can see',
  'prompt.fill': 'copies the text and asks the person to paste it; it never drafts or sends',
};
const NO_OPS = new Set(['ui.blit', 'ui.selection', 'session.messages']);
const NO_OP_NOUNS = new Set(['model', 'agent']);
const TIER3 = [/^process\.run$/, /^fs\.write$/, /^http\./, /^prompt\./];
// Every ported pane mod gets these; they don't make a port partial (scorecard: task-board is clean).
const FALLBACKS = new Set(['event command.run', '$.ui.open']);
const SITES = { Pane: null, AbovePrompt: 'drawn as a strip above the pane', PromptHint: 'drawn as a strip above the pane' };

export const isTranscriptSite = (component) => component !== '*' && !Object.hasOwn(SITES, component);

function constants(code, src) {
  const out = {};
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=['"`])/g)) {
    const lit = literalAt(code, src, m.index + m[0].length);
    if (lit && /^\s*(?:as\s+const\s*)?(?:;|\n|$)/.test(code.slice(lit.end + 1))) out[m[1]] = lit.value;
  }
  return out;
}

const valueOf = (field, consts) => (field?.literal !== undefined ? field.literal : field?.ident && Object.hasOwn(consts, field.ident) ? consts[field.ident] : undefined);

// Specifiers a file imports at runtime (type-only imports are erased by the transform).
export function importsOf(src) {
  const code = blank(src);
  const out = [];
  const at = (i) => literalAt(code, src, i)?.value;
  // The clause between the keyword and the next quote is checked with plain string
  // tests, not one backtracking regex: `import x from 'y'`, `import 'y'`, `export * from 'y'`.
  for (const m of code.matchAll(/\b(import|export)\b/g)) {
    const start = m.index + m[0].length;
    const quote = [code.indexOf("'", start), code.indexOf('"', start)].filter((i) => i >= 0);
    if (!quote.length) continue;
    const q = Math.min(...quote);
    const clause = code.slice(start, q);
    if (!/^[\w$*{}\s,]*$/.test(clause)) continue;
    const from = /\bfrom\s*$/.test(clause);
    if (m[1] === 'export' ? !from : !from && clause.trim() !== '') continue;
    if (/^\s+type\s/.test(clause)) continue; // type-only
    const spec = at(q);
    if (spec !== undefined) out.push(spec);
  }
  for (const m of code.matchAll(/(?<![\w$.])(?:import|require)\s*\(\s*(?=['"`])/g)) {
    const spec = at(m.index + m[0].length);
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

// files: [{path, src}], the mod's module and the helpers it imports.
export function scanMod(files) {
  const scan = { events: [], calls: new Set(), commands: [], tools: [], renderSites: new Set(), imports: [], warnings: [], steersBuiltinTools: false };
  for (const { path, src } of files) {
    const code = blank(src);
    const consts = constants(code, src);
    for (const spec of importsOf(src)) scan.imports.push({ file: path, spec });

    for (const m of code.matchAll(/(?<![\w$.])on\(\s*(?=['"])/g)) {
      const lit = literalAt(code, src, m.index + m[0].length);
      if (!lit) continue;
      const paren = code.lastIndexOf('(', m.index + m[0].length);
      const close = closeOf(code, paren);
      const rest = /^\s*,\s*/.exec(code.slice(lit.end + 1));
      const matcher = {};
      if (rest && code[lit.end + 1 + rest[0].length] === '{') {
        for (const [k, f] of Object.entries(objectFields(code, src, lit.end + 1 + rest[0].length))) {
          const v = valueOf(f, consts);
          matcher[k] = v ?? null;
          if (v === undefined) scan.warnings.push(`${path}: on('${lit.value}') matcher "${k}" isn't a literal`);
        }
      }
      const body = close > 0 ? code.slice(lit.end, close) : '';
      scan.events.push({ event: lit.value, matcher, file: path });
      if (lit.value === 'ui.render') scan.renderSites.add(matcher.component ?? '*');
      const builtin = lit.value === 'tool.call' && !String(matcher.tool ?? '').startsWith('mcp__');
      if (builtin && /\bdeny\s*:|\bnext\(\s*\{/.test(body)) scan.steersBuiltinTools = true;
    }

    for (const m of code.matchAll(/(?<![\w$.])\$\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
      if (m[2]) scan.calls.add(`${m[1]}.${m[2]}`);
      else scan.warnings.push(`${path}: $.${m[1]} is used without a method, so its calls can't be scanned and will throw`);
    }
    if (/(?<![\w$.])\$\s*\[/.test(code) || /\}\s*=\s*\$(?![\w$.])/.test(code)) {
      scan.warnings.push(`${path}: $ is accessed dynamically; calls the scan can't see will throw`);
    }

    for (const [kind, list] of [['command', scan.commands], ['tool', scan.tools]]) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])\\$\\.${kind}\\.register\\(\\s*`, 'g'))) {
        const at = m.index + m[0].length;
        if (code[at] !== '{') { scan.warnings.push(`${path}: a $.${kind}.register argument isn't an object literal`); continue; }
        const f = objectFields(code, src, at);
        const def = { name: valueOf(f.name, consts), description: valueOf(f.description, consts), argumentHint: valueOf(f.argumentHint, consts) };
        if (typeof def.name !== 'string') { scan.warnings.push(`${path}: a $.${kind}.register name isn't a literal`); continue; }
        if (kind === 'tool') delete def.argumentHint;
        if (!list.some((d) => d.name === def.name)) list.push(Object.fromEntries(Object.entries(def).filter(([, v]) => typeof v === 'string')));
      }
    }
  }
  // The runtime's 'claude-code' stand-in keeps atoms in $.state.
  if (scan.imports.some((i) => i.spec === 'claude-code')) { scan.calls.add('state.get'); scan.calls.add('state.set'); }
  scan.warnings = [...new Set(scan.warnings)];
  return scan;
}

// Verdict, per-item findings and tier for a scan. `findings` are {item, level, reason}:
// 'fallback' (every pane mod gets it, and the scorecard still calls the mod clean),
// 'partial' or 'none'.
export function assess(scan) {
  const findings = [];
  const refusals = [];
  const add = (item, level, reason) => { if (FALLBACKS.has(item)) level = 'fallback'; if (!findings.some((f) => f.item === item)) findings.push({ item, level, reason }); };
  for (const { event } of scan.events) {
    const known = Object.hasOwn(EVENTS, event) ? EVENTS[event] : ['none', 'no Antigravity equivalent; the handler never runs'];
    if (known) add(`event ${event}`, ...known);
  }
  for (const call of scan.calls) {
    const [noun] = call.split('.');
    if (WORKS.has(call)) continue;
    if (Object.hasOwn(PARTIAL, call)) add(`$.${call}`, 'partial', PARTIAL[call]);
    else if (NO_OPS.has(call) || NO_OP_NOUNS.has(noun)) add(`$.${call}`, 'partial', 'returns nothing in the Antigravity port');
    else add(`$.${call}`, 'none', 'not available in the Antigravity port (calls reject)');
  }
  const sites = [...scan.renderSites];
  for (const site of sites) {
    if (isTranscriptSite(site)) add(`render ${site}`, 'none', 'transcript render sites have no Antigravity equivalent');
    else if (SITES[site]) add(`render ${site}`, 'partial', SITES[site]);
  }
  if (sites.length && sites.every(isTranscriptSite)) {
    refusals.push(`draws only into transcript sites (${sites.join(', ')}), which Antigravity has no equivalent for`);
  }
  const bare = [...new Set(scan.imports.filter((i) => !/^\.{1,2}\//.test(i.spec) && i.spec !== 'claude-code').map((i) => i.spec))];
  if (bare.length) refusals.push(`imports ${bare.join(', ')}, which a ported mod can't load (only relative files and 'claude-code')`);
  const hasPane = scan.renderSites.has('Pane') || scan.renderSites.has('*');
  const warnings = [...scan.warnings];
  if (!hasPane && sites.some((s) => SITES[s])) warnings.push('no Pane: AbovePrompt/PromptHint draw only while the pane is open');

  const tierReasons = ['a sidecar is a full Node process outside agy\'s permission prompts'];
  for (const call of scan.calls) if (TIER3.some((re) => re.test(call))) tierReasons.push(`$.${call}`);
  if (scan.steersBuiltinTools) tierReasons.push('tool.call can deny or rewrite built-in tool calls');
  const tier = tierReasons.length > 1 ? 'TIER_3_AGENT_CONTROL' : 'TIER_2_LOCAL_TOOLING';
  const verdict = refusals.length ? 'refused' : findings.some((f) => f.level !== 'fallback') ? 'partial' : 'clean';
  return { verdict, refusals, findings, warnings, hasPane, tier, tierReasons };
}
