# agy baseline: what `agy plugin install` / `import` already do

This is the Phase 0 scorecard for `agy-plugin-porter` (see `docs/plan.md`). It measures what agy's built-in Claude Code and Gemini CLI import does, so the porter builds only the gaps.

**Runs.**
- Phase 0: 2026-10-22, agy 1.3.5.
- Step 0 re-run: 2026-10-22, agy 1.4.4. agy auto-updated to 1.4.5 in the background during the first live turn. Every row below was re-checked on 1.4.5. The 1.4.4 runs done before the update (staging, `validate`, JSON deny, SessionStart) gave the same results.

**Method.** Each run used a throwaway home: `USERPROFILE`/`HOME` pointed at a scratch dir. agy honors both, and auth still works. The real `~/.gemini/config` and `antigravity-cli/settings.json` were hash-checked before and after, and were unchanged. Fixtures are in `test/fixtures/`. "Live" means a real headless agent turn (`agy -p`) with the plugin installed. "Validator" means `agy plugin validate` output, which 1.4.x builds from the loader's own rules. It's agy's word, not a live turn.

These are point-in-time results against one agy build. The plan's CI differential test (Phase 0, "Ongoing") will catch agy upgrades automatically. Until it exists, re-run [Reproduce](#reproduce) by hand.

## Changes since 1.3.5

- **JSON deny confirmed live.** `{"decision":"deny","reason":R}` on stdout blocks the call, with `tool call denied by pre-tool hook: R`.
- **`{}` from PreToolUse is a deny** with an empty reason. Only empty stdout means "no opinion".
- **PostToolUse failures no longer fail the tool.** A nonzero exit is logged and the tool keeps its result. PreToolUse is still fail-closed on any nonzero exit.
- **SessionStart must be flat.** A grouped `[{"hooks":[...]}]` SessionStart is a validator error, and the loader skips the whole `hooks.json`.
- **Quoted relative paths break too**, not only quoted absolute ones.
- **Claude agents no longer load.** `tools: Read, Grep` (a string) fails YAML unmarshalling into a list, so the loader skips the agent. 1.3.5 still counted it.
- **`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in plugin MCP `args`, `env` and `cwd`.** This is confirmed live for `args`. They are not expanded in hook commands (agy's own error string, static).
- **`agy plugin validate` is now a real oracle.** It flags Claude-shaped hooks, Claude tool names in matchers (and names the agy tool), unknown events, `hooks/hooks.json`, `.mcp.json`, `commands/`, a root `GEMINI.md`, and skills without `name`.

## How import works

- `agy plugin install <dir>` and `agy plugin import <dir>` run the **same staging pipeline**, and their output is byte-identical. Staging on 1.4.5 is byte-identical to 1.4.4.
- `agy plugin import claude|gemini` adds only a directory scan: it imports each direct child of `~/.claude/plugins/` and `~/.gemini/extensions/`. It does **not** find plugins installed through Claude Code's marketplace layout (`~/.claude/plugins/marketplaces/*/plugins/*`, `cache/`, `installed_plugins.json`) or the desktop app's `synced/` store. On a real Claude Code profile it reports "No claude extensions found." (Phase 0, not re-checked.)
- Detection covers `.claude-plugin/plugin.json` and `gemini-extension.json` only. Cursor (`.cursor/rules`, `.cursorrules`), Roo/Kilo (`.roomodes`) and Codex (`.agents/skills`) sources all fail with `could not detect plugin structure`.
- `agy plugin validate <dir>` checks a directory with a root `plugin.json`, so it can check the porter's **output** but not a raw source. `--strict` fails on warnings and `--json` gives a machine-readable report.
- agy writes `~/.gemini/config/import_manifest.json` (name, source, importedAt, components).
- agy reports success even when components are dead. `install` prints "hooks: 2 processed" for a hooks file the loader then skips, and `plugin list --json` lists `description` and `hooks` as hook names.

## Scorecard

Results are from agy 1.4.5.

| Plan item | Claude source | Gemini source | Evidence |
| :-- | :-- | :-- | :-- |
| Detect / stage plugin dir | **handles** | **handles** | `[ok]` and lists components |
| Manifest → `plugin.json` | **partial**: keeps `author` (as a string), drops `homepage`/`keywords` | **handles** | Loader ignores `author`, so it's harmless |
| `plugin.json` inline `mcpServers` | **not handled**: silently dropped | n/a | Only the `.mcp.json` server survived |
| `.mcp.json` / extension MCP → `mcp_config.json` | **handles** | **handles** | Adds `cwd:""` and `env:null`. Leaves `.mcp.json` behind, which the validator flags as never loaded. |
| MCP name prefixing | **handled by the runtime** | **handled by the runtime** | Live: servers listed as `fixture-claude_github` and `fixture-gemini_memory`. The porter must **not** prefix (it would double-prefix). |
| Path variables in MCP args | **not handled**: `${CLAUDE_PLUGIN_ROOT}` left literal, so the server never starts | **handles**: `${extensionPath}`/`${/}` expanded to absolute paths | Live: renaming the arg to `${PLUGIN_ROOT}` made the server start. The validator warns that `${CLAUDE_PLUGIN_ROOT}` isn't declared in `"variables"`. |
| Hooks relocated to root `hooks.json` | **handles** (copy) | **handles** (copy) | `hooks/hooks.json` is also left in place. The validator flags it as never loaded. |
| Hook config shape restructure | **not handled**: Claude shape kept, and the **whole file is skipped** | **not handled**: the **whole file is skipped** | Log and validator: Claude's top-level `"description"` string fails to parse. Gemini's `"hooks"` is read as one hook with no `command`. Neither fires. |
| Matcher remap (`Bash` → `run_command`, `Edit\|Write` → …) | **not handled** | **not handled** (`run_shell_command` kept) | The validator names the agy tool for each Claude name. See [Tool names](#tool-names). |
| Event mapping (`UserPromptSubmit`, `BeforeTool`, `Notification`, …) | **not handled**, copied verbatim | **not handled** | The validator warns "unknown event … is ignored". Install doesn't. |
| `${CLAUDE_PLUGIN_ROOT}` in hook commands | **not handled** | **handles** (expanded at install) | Live: neither `${CLAUDE_PLUGIN_ROOT}` nor `${extensionPath}` is expanded at run time, the env var is **unset**, and the hook cwd is the plugin root. |
| Windows quoting of hook commands | **bug in agy** | — | Live: agy prepends the cwd to a quoted argument, so `node "scripts/x.mjs"` and `node "C:\…\x.mjs"` both give `MODULE_NOT_FOUND`. Unquoted relative paths work. |
| Hook stdin payload | **not translated** (camelCase protojson is sent) | **not translated** | Live payload: `toolCall.{name,args}`, `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `stepIdx`. PostToolUse adds `error` (empty on success). |
| Exit code 2 → deny | **partial**: any nonzero PreToolUse exit **fails the tool call** with an error that includes stderr | same | See [Hook contract](#hook-contract). JSON deny is the clean path and is confirmed live. |
| SessionStart stdout text → context | **not handled** | **not handled** | Live: plain stdout fails protojson parsing and is dropped. Flat `injectSteps` works. |
| Commands → skills | **partial**: `commands/x.md` → `skills/<plugin>-cmd-x/SKILL.md`; frontmatter copied verbatim (no `name`; `argument-hint`, `allowed-tools` and `$ARGUMENTS` left in) | **handles**: `commands/ns/x.toml` → `skills/x/SKILL.md` with `name`+`description`; `{{args}}` left in | Without `name`, the Claude skill loads as `SKILL` (`plugin list --json`, validator) |
| Native `skills/*/SKILL.md` | **handles** (copy) | **handles** | |
| Claude `agents/*.md` → agents | **not handled**: copied flat, then **skipped by the loader** | n/a | Validator: `tools` string can't unmarshal into `[]string`. Live: absent from the subagent list. `model: sonnet` is also unmapped. |
| `CLAUDE.md` / `GEMINI.md` → `rules/` | **not handled** | **not handled** | Live: the rule marker was absent from context. The validator flags a root `GEMINI.md`, but not `CLAUDE.md`. |
| Security audit (Unicode tags, `curl\|sh`, entropy, rules budget) | **not handled** | **not handled** | Nothing is scanned during install |

Other sources aren't detected at all, so none of their components are handled. This covers Cursor (`.mdc`, `.cursorrules`), Roo/Kilo (`.roomodes`) and Codex (`.agents/skills`). See [How import works](#how-import-works).

Real upstreams behave like the fixture (Phase 0, 1.3.5). `hookify` and `security-guidance` from `claude-plugins-official` install `[ok]` with "hooks: 2 processed", but their hooks stay Claude-shaped with `${CLAUDE_PLUGIN_ROOT}` and `python3 "…"` quoting. Per the live results above, those hooks don't run. `security-guidance` also relies on `UserPromptSubmit`, which has no Antigravity event.

## Hook contract

Live on agy 1.4.5 with `test/fixtures/agy-probe/`, headless (`agy -p`). Hook ids in the log look like `jsonhook__<name>_<Event>_<group>_<handler>`.

| Hook result | Effect |
| :-- | :-- |
| PreToolUse, exit 0, empty stdout | No opinion. The normal permission flow runs: an allow-listed command ran, and an unlisted one was auto-denied by headless mode, the same as with no hook. |
| PreToolUse, exit 0, `{}` | **Deny**, with an empty reason (`tool call denied by pre-tool hook: `) |
| PreToolUse, exit 0, `{"decision":"deny","reason":R}` | Deny: `tool call denied by pre-tool hook: R` |
| PreToolUse, exit 0, `{"decision":"allow"}` | Did **not** bypass headless mode's permission check for an unlisted command. Interactive mode is untested. |
| PreToolUse, exit 1 or exit 2 | The tool call fails: `JSON hook "<id>" failed: command failed: exit status N, stderr: …` |
| PostToolUse, exit 1 | Logged. The tool keeps its result. |
| SessionStart, plain stdout | Logged as a protojson parse error and dropped |
| SessionStart, flat `[{type,command}]` with `injectSteps` | Injected as a system message |
| SessionStart, grouped `[{"hooks":[...]}]` | Validator error. The loader skips the whole `hooks.json`. |

## Tool names

The matcher target is the agy tool name. The validator maps Claude names to agy names, giving two choices where the CLI and the IDE differ. The CLI names `run_command`, `write_file`, `read_file` and `edit_file` were seen live.

| Claude | agy (validator) |
| :-- | :-- |
| `Bash` | `run_command` |
| `Read` | `view_file` or `read_file` |
| `Write` | `write_to_file` or `write_file` |
| `Edit` | `replace_file_content` or `edit_file` |
| `MultiEdit` | `multi_replace_file_content` or `edit_file` |
| `Grep` | `grep_search` |
| `Glob` | `find_by_name` |
| `LS` | `list_dir` |
| `WebFetch` | `read_url_content` |
| `WebSearch` | `search_web` |
| `NotebookEdit` | `notebook_edit` |
| `Task` | `invoke_subagent` |
| `TodoWrite` | none ("no built-in tool does the same job") |

The validator doesn't know `NotebookRead`, `BashOutput`, `KillShell`, `SlashCommand`, `ExitPlanMode` or `mcp__*` names, and passes them silently. They never match.

Live CLI tool args: `run_command` `{CommandLine, WaitMsBeforeAsync, toolSummary}`, `write_file` `{Path, Content, Overwrite}`, `read_file` `{Path}`, `edit_file` `{Path, Target, Replacement}`. The IDE-named tools' args are unverified.

## What this means for the porter

**Delete from scope (agy or the runtime already does it):**
- MCP namespacing. The runtime prefixes with the plugin name.
- Staging, root-relocating and copying skills, commands and MCP for Claude/Gemini. The porter runs `agy plugin install` for that and post-processes the staged directory.
- Gemini path-variable expansion.

**Keep, and these are now the porter's core value:**
1. **Hook compiler.** Restructure the config into the native named-hook shape, and never carry over non-hook top-level keys like `description`. Emit SessionStart, PreInvocation, PostInvocation and Stop **flat**. Remap matchers from the [Tool names](#tool-names) table, emitting both alternatives. Remap events and report unmappable ones. Emit unquoted, cwd-relative commands that go through the shim.
2. **Hook shim.** Set `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PROJECT_DIR` and translate the stdin payload to snake_case. Map exit 2 → `{"decision":"deny","reason":stderr}`, confirmed live. For "no opinion", print **nothing**, never `{}`. Wrap SessionStart stdout text → flat `injectSteps`. Other nonzero exits allow the call with a warning on stderr, matching Claude's non-blocking semantics rather than agy's fail-closed default (decided for Phase 1). agy only logs that warning in `cli-*.log`.
3. **MCP fixes for Claude.** Rescue `plugin.json` inline `mcpServers`. Rewrite `${CLAUDE_PLUGIN_ROOT}` to `${PLUGIN_ROOT}` in `args`/`env`/`cwd` (live), so no absolute paths are baked in at install time. Remove the leftover `.mcp.json`.
4. **Rules.** `CLAUDE.md`/`GEMINI.md` → `rules/AGENTS.md`, within the budget.
5. **Command and agent cleanup.** Add skill `name` and strip Claude-only frontmatter. Agents are now load-blocking: rewrite `tools` as a list of agy tool names (or drop it) and map or drop `model`.
6. **Cursor, Roo/Kilo and Codex compilers.** agy doesn't detect these at all.
7. **Static auditor and port report.** agy reports success even when components are dead, so the report has to say what actually works. Use `agy plugin validate --strict --json` as a test oracle for the output.

**`agy plugin import` itself.** It brings no benefit over `install <dir>`, and its scan misses real Claude Code installs. Hangar, which calls the porter, should not wrap it. A Hangar "Import from Claude Code" feature would have to enumerate `~/.claude/plugins/installed_plugins.json` and the marketplace cache itself, then call the porter. That stays a later candidate, not part of this rollout.

## Reproduce

Use a throwaway home, and hash the real profile before and after:

```bash
H=$(mktemp -d); export USERPROFILE=$(cygpath -w "$H") HOME=$(cygpath -w "$H") NO_COLOR=1
(cd ~/.gemini && find config antigravity-cli -maxdepth 4 -type f \( -path 'config/*' -o -name settings.json \) -print0 | sort -z | xargs -0 sha256sum) > before.sha
agy plugin install "$(cygpath -w test/fixtures/claude)"
agy plugin install "$(cygpath -w test/fixtures/agy-probe)"
agy plugin list --json
agy plugin validate "$(cygpath -w "$H/.gemini/config/plugins/fixture-claude")"
```

For live checks, add allow rules to `$H/.gemini/antigravity-cli/settings.json`:

```json
{"permissions":{"allow":["command(echo porter-fixture-allow)","command(echo porter-fixture-deny)","command(echo porter-fixture-exit1)","command(echo porter-fixture-exit2)"]}}
```

Every probe hook ships with `"enabled": false`. Enable only the ones under test, because PreToolUse hooks run in sequence and one deny masks the rest:

```bash
ON=probe-pre-json,probe-session-flat node -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f)),on=new Set(process.env.ON.split(","));for(const k in j)j[k].enabled=on.has(k);fs.writeFileSync(f,JSON.stringify(j,null,2))' "$H/.gemini/config/plugins/hook-probe/hooks.json"
PROBE_LOG=$(cygpath -w "$H/probe.log") agy -p "Run exactly this shell command once: echo porter-fixture-deny . Then quote the tool result verbatim." --print-timeout 180s
```

- Probe payloads go to `$PROBE_LOG`. The Claude fixture's scripts append to `%TEMP%\agy-porter-fixture.log`.
- Hook errors and skipped files are in `$H/.gemini/antigravity-cli/log/cli-*.log`.
- agy auto-updates in the background. Check `Language server version` in that log to see which build ran.
