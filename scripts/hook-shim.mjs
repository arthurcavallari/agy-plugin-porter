#!/usr/bin/env node
// Runtime bridge shipped into each ported plugin by agy-plugin-porter.
// agy runs `node scripts/hook-shim.mjs --event <Event> --hook <id>` with the
// plugin root as cwd. The shim looks up the original Claude Code / Gemini CLI
// command in hook-shim.json, feeds it a translated payload, and turns its exit
// code and output back into agy's hook contract. It has no dependencies.
//
// agy contract (live-tested on agy 1.4.5, see docs/agy-baseline.md):
// - PreToolUse: empty stdout is "no opinion"; `{}` is a deny; any nonzero exit
//   fails the tool call. So the shim always exits 0 and prints nothing unless
//   the script decided something.
// - SessionStart / Stop / PostToolUse: stdout must be a JSON object.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// agy tool name -> source tool name and arg renames. Arg names are the agy CLI's
// as seen live; the IDE-named tools reuse them unverified. Unknown args pass through.
const FILE_ARGS = { Path: 'file_path' };
const REVERSE = {
  claude: {
    run_command: ['Bash', { CommandLine: 'command' }],
    view_file: ['Read', FILE_ARGS],
    read_file: ['Read', FILE_ARGS],
    write_to_file: ['Write', { ...FILE_ARGS, Content: 'content' }],
    write_file: ['Write', { ...FILE_ARGS, Content: 'content' }],
    replace_file_content: ['Edit', { ...FILE_ARGS, Target: 'old_string', Replacement: 'new_string' }],
    edit_file: ['Edit', { ...FILE_ARGS, Target: 'old_string', Replacement: 'new_string' }],
    multi_replace_file_content: ['MultiEdit', FILE_ARGS],
    grep_search: ['Grep', {}],
    find_by_name: ['Glob', {}],
    list_dir: ['LS', {}],
    read_url_content: ['WebFetch', {}],
    search_web: ['WebSearch', {}],
    notebook_edit: ['NotebookEdit', {}],
    invoke_subagent: ['Task', {}],
  },
  gemini: {
    run_command: ['run_shell_command', { CommandLine: 'command' }],
    view_file: ['read_file', { Path: 'absolute_path' }],
    read_file: ['read_file', { Path: 'absolute_path' }],
    write_to_file: ['write_file', { ...FILE_ARGS, Content: 'content' }],
    write_file: ['write_file', { ...FILE_ARGS, Content: 'content' }],
    replace_file_content: ['replace', { ...FILE_ARGS, Target: 'old_string', Replacement: 'new_string' }],
    edit_file: ['replace', { ...FILE_ARGS, Target: 'old_string', Replacement: 'new_string' }],
    grep_search: ['search_file_content', {}],
    find_by_name: ['glob', {}],
    list_dir: ['list_directory', {}],
    read_url_content: ['web_fetch', {}],
    search_web: ['google_web_search', {}],
  },
};

const renameKeys = (obj, renames) => Object.fromEntries(
  Object.entries(obj ?? {}).map(([k, v]) => [renames[k] ?? k, v]));
const invert = (renames) => Object.fromEntries(Object.entries(renames).map(([k, v]) => [v, k]));

export function toSourceTool(toolCall, dialect) {
  const [name, renames] = REVERSE[dialect]?.[toolCall?.name] ?? [toolCall?.name ?? '', {}];
  return { tool_name: name, tool_input: renameKeys(toolCall?.args, renames) };
}

// Source payload (snake_case) from agy's camelCase protojson payload.
export function toSourcePayload(entry, payload) {
  const base = {
    session_id: payload.conversationId ?? '',
    transcript_path: payload.transcriptPath ?? '',
    cwd: payload.workspacePaths?.[0] ?? process.cwd(),
    hook_event_name: entry.sourceEvent,
  };
  if (entry.dialect === 'gemini') base.timestamp = new Date().toISOString();
  else base.permission_mode = 'default';
  switch (entry.event) {
    case 'PreToolUse':
      return { ...base, ...toSourceTool(payload.toolCall, entry.dialect) };
    case 'PostToolUse':
      if (entry.sourceEvent === 'PostToolUseFailure') return { ...base, ...toSourceTool(payload.toolCall, entry.dialect), error: payload.error ?? '' };
      return { ...base, ...toSourceTool(payload.toolCall, entry.dialect), tool_response: payload.error ? { error: payload.error } : {} };
    case 'SessionStart':
      return { ...base, source: 'startup' };
    case 'Stop':
      return { ...base, stop_hook_active: Number(payload.executionNum ?? 1) > 1 };
    default:
      return base;
  }
}

// Expands the plugin-path variables Claude Code and Gemini CLI provide, so the
// command works under cmd.exe too. Unknown variables are left to the shell.
export function expandCommand(command, vars) {
  const values = { ...vars, '/': sep };
  return command.replace(/\$\{([A-Za-z_]\w*|\/)\}|\$([A-Za-z_]\w*)/g, (whole, braced, bare) => {
    const name = braced ?? bare;
    return Object.hasOwn(values, name) ? values[name] : whole;
  });
}

const NO_OPINION = { PreToolUse: '' };
export const noOpinion = (event) => NO_OPINION[event] ?? '{}';

// agy has one PostToolUse with `error` set when the tool failed (empty on
// success, live-tested). Claude splits it: PostToolUse runs on success only,
// PostToolUseFailure on failure only.
export function shouldRun(entry, payload) {
  if (entry.event !== 'PostToolUse' || entry.dialect !== 'claude') return true;
  return Boolean(payload.error) === (entry.sourceEvent === 'PostToolUseFailure');
}

function parseJson(text) {
  if (!text.startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Turns the script's {code, stdout, stderr} into agy's stdout. Returns
// {stdout, warning?}. A nonzero exit other than 2 (or a timeout) never blocks:
// that matches Claude Code and Gemini CLI, where only exit 2 is blocking.
export function translateResult(entry, result) {
  const event = entry.event;
  const stdout = (result.stdout ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const stderr = (result.stderr ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (result.timedOut || result.spawnError || (result.code !== 0 && result.code !== 2)) {
    const why = result.timedOut ? `timed out after ${entry.timeout}s`
      : result.spawnError ? `failed to start: ${result.spawnError}` : `exited with code ${result.code}`;
    return { stdout: noOpinion(event), warning: `${why}; not blocking${stderr ? `. stderr: ${stderr}` : ''}` };
  }
  const blocked = result.code === 2;
  const json = blocked ? null : parseJson(stdout);
  const specific = json?.hookSpecificOutput ?? {};

  if (event === 'PreToolUse') {
    const reasonOr = (r, fallback) => (typeof r === 'string' && r.trim() ? r.trim() : fallback);
    if (blocked) return { stdout: JSON.stringify({ decision: 'deny', reason: reasonOr(stderr, 'Blocked by hook') }) };
    if (!json) return { stdout: '' };
    let decision = ['allow', 'deny', 'ask'].includes(specific.permissionDecision) ? specific.permissionDecision : null;
    let reason = specific.permissionDecisionReason;
    if (!decision && typeof json.decision === 'string') {
      decision = { block: 'deny', deny: 'deny', approve: 'allow', allow: 'allow', ask: 'ask' }[json.decision] ?? null;
      reason = json.reason;
    }
    if (!decision && json.continue === false) {
      decision = 'deny';
      reason = json.stopReason;
    }
    if (!decision) return { stdout: '' };
    const out = { decision };
    if (decision === 'deny') out.reason = reasonOr(reason, 'Blocked by hook');
    else if (typeof reason === 'string' && reason) out.reason = reason;
    if (decision !== 'deny' && specific.updatedInput && typeof specific.updatedInput === 'object') {
      const renames = REVERSE[entry.dialect]?.[entry.toolName]?.[1] ?? {};
      out.overwrite = renameKeys(specific.updatedInput, invert(renames));
    }
    return { stdout: JSON.stringify(out) };
  }

  if (event === 'SessionStart') {
    const text = json ? specific.additionalContext : (blocked ? '' : stdout);
    if (typeof text !== 'string' || !text.trim()) return { stdout: '{}' };
    return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text.trim() } }] }) };
  }

  if (event === 'Stop') {
    if (blocked) return { stdout: JSON.stringify({ decision: 'continue', reason: stderr || 'A stop hook asked to continue.' }) };
    if (json?.decision === 'block') return { stdout: JSON.stringify({ decision: 'continue', reason: json.reason ?? 'A stop hook asked to continue.' }) };
    return { stdout: '{}' };
  }

  // PostToolUse: agy only takes {}. Feedback for the model has nowhere to go.
  const feedback = blocked ? stderr : (json?.decision === 'block' ? json.reason : '');
  return { stdout: '{}', ...(feedback ? { warning: `PostToolUse feedback dropped (agy has no channel for it): ${feedback}` } : {}) };
}

export function runCommand(command, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...extra });
    };
    const timer = setTimeout(() => { child?.kill(); finish({ timedOut: true }); }, timeoutMs);
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    } catch (err) {
      finish({ spawnError: err.message });
      return;
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event') opts.event = argv[++i];
    else if (argv[i] === '--hook') opts.hook = argv[++i];
  }
  return opts;
}

async function main() {
  const { event = 'PreToolUse', hook } = parseArgs(process.argv.slice(2));
  const warn = (text) => process.stderr.write(`agy-porter hook-shim [${hook ?? '?'}]: ${text}\n`);
  let out = noOpinion(event);
  try {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}'); } catch {}
    const pluginRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
    const config = JSON.parse(readFileSync(new URL('./hook-shim.json', import.meta.url), 'utf8'));
    const entry = config.hooks?.[hook];
    if (!entry) throw new Error(`no hook "${hook}" in hook-shim.json`);
    if (!shouldRun(entry, payload)) {
      process.stdout.write(out, () => process.exit(0));
      return;
    }
    const projectDir = payload.workspacePaths?.[0] ?? process.cwd();
    const vars = entry.dialect === 'gemini'
      ? { extensionPath: pluginRoot, GEMINI_PROJECT_DIR: projectDir, CLAUDE_PROJECT_DIR: projectDir }
      : { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: projectDir };
    const result = await runCommand(expandCommand(entry.command, vars), {
      cwd: pluginRoot,
      env: { ...process.env, ...vars },
      input: JSON.stringify(toSourcePayload(entry, payload)),
      timeoutMs: (entry.timeout ?? 60) * 1000,
    });
    const translated = translateResult({ ...entry, toolName: payload.toolCall?.name }, result);
    out = translated.stdout;
    if (translated.warning) warn(translated.warning);
  } catch (err) {
    warn(`${err.message}; not blocking`);
  }
  process.stdout.write(out, () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
