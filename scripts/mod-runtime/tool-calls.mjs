// agy tool calls <-> Claude Code tool.call input. The names match lib/tool-map.mjs
// (test/mod-runtime.test.mjs checks it); this copy ships alone inside each sidecar.
// Arg names: the agy CLI's, which the desktop app uses too (live, ui-mods-baseline.md).
const AGY_TO_CLAUDE = {
  run_command: 'Bash', view_file: 'Read', read_file: 'Read', write_to_file: 'Write', write_file: 'Write',
  replace_file_content: 'Edit', edit_file: 'Edit', multi_replace_file_content: 'MultiEdit', grep_search: 'Grep',
  find_by_name: 'Glob', list_dir: 'LS', read_url_content: 'WebFetch', search_web: 'WebSearch',
  notebook_edit: 'NotebookEdit', invoke_subagent: 'Task',
};
const ARG_NAMES = {
  CommandLine: 'command', Path: 'file_path', TargetFile: 'file_path', AbsolutePath: 'file_path',
  Content: 'content', CodeContent: 'content', Target: 'old_string', Replacement: 'new_string',
};
// Tool args come from the model; never let one reach an object's prototype.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const claudeToolName = (agyName) => AGY_TO_CLAUDE[agyName] ?? agyName;

function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }

// Returns {e, args}: the Claude-shaped event and the raw agy args.
export function toClaudeCall(toolCall) {
  const raw = typeof toolCall?.args === 'string' ? safeJson(toolCall.args) : toolCall?.args;
  const args = raw && typeof raw === 'object' ? raw : {};
  const toolName = toolCall?.name ?? '';
  if ((toolName === 'call_mcp_tool' || toolName === 'mcp_tool') && (args.ServerName || args.server_name) && (args.ToolName || args.tool_name)) {
    const server = args.ServerName ?? args.server_name;
    const tool = args.ToolName ?? args.tool_name;
    const argKey = 'Arguments' in args ? 'Arguments' : ('arguments' in args ? 'arguments' : 'Arguments');
    const rawInner = args[argKey];
    const inner = typeof rawInner === 'string' ? safeJson(rawInner) : (rawInner && typeof rawInner === 'object' ? rawInner : {});
    const e = { tool: `mcp__${server}__${tool}` };
    for (const [k, v] of Object.entries(inner)) if (!UNSAFE_KEYS.has(k)) e[k] = v;
    const taggedArgs = Object.defineProperty({ ...args }, '_mcpEnvelope', {
      value: { argKey, wasString: typeof rawInner === 'string', inner },
      enumerable: false,
    });
    return { e, args: taggedArgs };
  }
  let mappedTool = claudeToolName(toolName);
  if (mappedTool === toolName && toolName.startsWith('mcp_') && toolName !== 'mcp_tool') {
    const rest = toolName.slice(4);
    const idx = rest.indexOf('_');
    if (idx > 0) mappedTool = `mcp__${rest.slice(0, idx)}__${rest.slice(idx + 1)}`;
  }
  const e = { tool: mappedTool };
  for (const [k, v] of Object.entries(args)) if (!UNSAFE_KEYS.has(k)) e[ARG_NAMES[k] ?? k] = v;
  const chunks = args.ReplacementChunks;
  if (Array.isArray(chunks) && chunks.length) {
    e.old_string = chunks.map((c) => c?.TargetContent ?? '').join('\n…\n');
    e.new_string = chunks.map((c) => c?.ReplacementContent ?? '').join('\n…\n');
  }
  return { e, args };
}

// The args a handler's next({...changed}) changed, under their agy names: an agy
// `overwrite`. Returns null when nothing changed.
export function overwriteOf(args, before, after) {
  if (args?._mcpEnvelope) {
    const { argKey, wasString, inner } = args._mcpEnvelope;
    const nextInner = { ...inner };
    let changed = false;
    for (const k of Object.keys({ ...inner, ...after })) {
      if (k === 'tool' || UNSAFE_KEYS.has(k)) continue;
      if (after[k] !== before[k]) {
        nextInner[k] = after[k];
        changed = true;
      }
    }
    if (!changed) return null;
    return {
      ...args,
      [argKey]: wasString ? JSON.stringify(nextInner) : nextInner,
    };
  }
  const out = {};
  for (const k of Object.keys(args)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const name = ARG_NAMES[k] ?? k;
    if (after[name] !== before[name]) out[k] = after[name];
  }
  return Object.keys(out).length ? out : null;
}
