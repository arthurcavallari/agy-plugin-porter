# agy baseline: what `agy plugin install` / `import` already do

Baseline benchmark for `agy-plugin-porter`, run before any porter code exists. It measures what agy 1.3.5's built-in Claude Code and Gemini CLI import does, so the porter builds only the gaps.

**Date:** 2026-10-22. **agy:** 1.3.5 (Windows 11). **Method:** each run used a throwaway home (`USERPROFILE`/`HOME` pointed at a scratch dir; agy honors both, and auth still works). The real profile was hash-checked before and after and was unchanged. Fixtures are in `test/fixtures/`. "Live" means a real headless agent turn (`agy -p`) with the plugin installed.

These are point-in-time results against one agy build. Re-run them when agy updates. There's no automated differential test yet, so re-running means following [Reproduce](#reproduce) by hand.

> **Stale:** agy has since updated to 1.4.4 on the benchmark machine. Nothing below has been re-checked against 1.4.4.

## How import works

- `agy plugin install <dir>` and `agy plugin import <dir>` run the **same staging pipeline**, and their output is byte-identical.
- `agy plugin import claude|gemini` adds only a directory scan: it imports each direct child of `~/.claude/plugins/` and `~/.gemini/extensions/`. It does **not** find plugins installed through Claude Code's marketplace layout (`~/.claude/plugins/marketplaces/*/plugins/*`, `cache/`, `installed_plugins.json`) or the desktop app's `synced/` store. On a real Claude Code profile it reports "No claude extensions found."
- Detection covers `.claude-plugin/plugin.json` and `gemini-extension.json` only. Cursor (`.cursor/rules`, `.cursorrules`), Roo/Kilo (`.roomodes`) and Codex (`.agents/skills`) sources all fail with `could not detect plugin structure`.
- `agy plugin validate <dir>` only accepts a directory that already has a root `plugin.json`, so it can check the porter's **output** but not a raw source.
- agy writes `~/.gemini/config/import_manifest.json` (name, source, importedAt, components).

## Scorecard

| Porter feature | Claude source | Gemini source | Evidence |
| :-- | :-- | :-- | :-- |
| Detect / stage plugin dir | **handles** | **handles** | `[ok]` and lists components |
| Manifest → `plugin.json` | **partial**: keeps `author` (as a string), drops `homepage`/`keywords` | **handles** | Loader ignores `author`, so it's harmless |
| `plugin.json` inline `mcpServers` | **not handled**: silently dropped | n/a | Only the `.mcp.json` server survived |
| `.mcp.json` / extension MCP → `mcp_config.json` | **handles** | **handles** | Adds `cwd:""` and `env:null` |
| MCP name prefixing | **handled by the runtime** | **handled by the runtime** | Live: server listed as `fixture-claude_<server>`. The porter must **not** prefix (it would double-prefix). |
| Path variables in MCP args | **not handled**: `${CLAUDE_PLUGIN_ROOT}` left literal, so the server never starts | **handles**: `${extensionPath}`/`${/}` expanded to absolute paths | Live: zero MCP tools until the path was made absolute |
| Hooks relocated to root `hooks.json` | **handles** (copy) | **handles** (copy) | `hooks/hooks.json` copied to the root |
| Hook config shape restructure | **not handled**: Claude `{"hooks":{Event:[...]}}` kept, and it **never fires** | **not handled**: Gemini `BeforeTool` event kept | Live: hooks fired only in the native `{<name>:{Event:[...]}}` shape. The Claude shape stayed silent even with fixed paths. agy still reports "hooks: N processed". |
| Matcher remap (`Bash` → `run_command`, `Edit|Write` → …) | **not handled** | **not handled** (`run_shell_command` kept) | |
| Event mapping (`UserPromptSubmit`, `BeforeTool`, `Notification`, …) | **not handled**, copied verbatim | **not handled** | Unknown events are not reported to the user |
| `${CLAUDE_PLUGIN_ROOT}` in hook commands | **not handled** | **handles** (expanded) | Live: the env var is **unset**, and the hook cwd is the plugin root |
| Windows quoting of hook commands | **bug in agy** | — | Live: `node "C:\…\x.mjs"` passed the quotes into the path, giving `MODULE_NOT_FOUND`. Unquoted relative paths work. |
| Hook stdin payload | **not translated** (camelCase protojson is sent) | **not translated** | Live payload: `toolCall.name=run_command`, `toolCall.args.CommandLine`, `conversationId`, `workspacePaths`, `transcriptPath`, `stepIdx` |
| Exit code 2 → deny | **partial**: any nonzero exit **fails the tool call** with an error that includes stderr | same | Live: blocks, but as an error, not `{"decision":"deny"}`. Exit 1 (a crashing hook) also blocks (fail-closed), while Claude treats non-2 errors as non-blocking. |
| SessionStart stdout text → context | **not handled** | **not handled** | Live: plain stdout was dropped. `{"injectSteps":[{"systemMessage":{"systemMessage":…}}]}` worked. |
| Commands → skills | **partial**: `commands/x.md` → `skills/<plugin>-cmd-x/SKILL.md`; frontmatter copied verbatim (no `name`; `argument-hint`, `allowed-tools` and `$ARGUMENTS` left in) | **handles**: `commands/ns/x.toml` → `skills/x/SKILL.md` with `name`+`description`; `{{args}}` left in | Both count as skills in `plugin list` |
| Native `skills/*/SKILL.md` | **handles** (copy) | **handles** | |
| Claude `agents/*.md` → agents | **partial**: copied flat and counted as an agent, but Claude tool names (`Read, Grep, Glob, Bash`) and `model: sonnet` are not mapped | n/a | |
| `CLAUDE.md` / `GEMINI.md` → `rules/` | **not handled** | **not handled** | Live: the rule marker was absent from context, and `plugin list` shows no rules |
| Security audit (Unicode tags, `curl\|sh`, entropy, rules budget) | **not handled** | **not handled** | Nothing is scanned during install |

Other sources aren't detected at all, so none of their components are handled. This covers Cursor (`.mdc`, `.cursorrules`), Roo/Kilo (`.roomodes`) and Codex (`.agents/skills`). See [How import works](#how-import-works).

Real upstreams behave like the fixture. `hookify` and `security-guidance` from `claude-plugins-official` install `[ok]` with "hooks: 2 processed", but their hooks stay Claude-shaped with `${CLAUDE_PLUGIN_ROOT}` and `python3 "…"` quoting. Per the live results above, those hooks don't run. `security-guidance` also relies on `UserPromptSubmit`, which has no Antigravity event.

## What this means for the porter

**Delete from scope (agy or the runtime already does it):**
- MCP namespacing. The runtime prefixes with the plugin name.
- Staging, root-relocating and copying skills, commands and MCP for Claude/Gemini. The porter runs `agy plugin install` for that and post-processes the staged directory.
- Gemini path-variable expansion.

**Keep, and these are now the porter's core value:**
1. **Hook compiler.** Restructure the config into the native named-hook shape, remap matchers and events (report unmappable ones), and emit unquoted, cwd-relative commands that go through the shim.
2. **Hook shim.** Set `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PROJECT_DIR`, translate the stdin payload to snake_case, map exit 2 → `{"decision":"deny","reason":stderr}`, map other nonzero exits → allow plus a warning (Claude's non-blocking semantics, instead of agy's fail-closed), and wrap SessionStart stdout text → `injectSteps`. The `injectSteps` shape is confirmed live. The `{"decision":"deny"}` output is **not** verified yet: the runs above only show agy blocking through a failed tool call. Confirm agy accepts the deny JSON before relying on it.
3. **MCP fixes for Claude.** Rescue `plugin.json` inline `mcpServers` and rewrite `${CLAUDE_PLUGIN_ROOT}` in args to absolute paths at install time.
4. **Rules.** `CLAUDE.md`/`GEMINI.md` → `rules/AGENTS.md`, within the budget.
5. **Command and agent cleanup.** Add skill `name`, strip Claude-only frontmatter, and map agent tool names.
6. **Cursor, Roo/Kilo and Codex compilers.** agy doesn't detect these at all.
7. **Static auditor and port report.** agy reports success even when components are dead, so the report has to say what actually works.

**`agy plugin import` itself.** It brings no benefit over `install <dir>`, and its scan misses real Claude Code installs. Hangar, which calls the porter, should not wrap it. A Hangar "Import from Claude Code" feature would have to enumerate `~/.claude/plugins/installed_plugins.json` and the marketplace cache itself, then call the porter. That stays a later candidate, not part of this rollout.

## Reproduce

```bash
H=$(mktemp -d); export USERPROFILE=$(cygpath -w "$H") HOME=$(cygpath -w "$H")
agy plugin install "$(cygpath -w test/fixtures/claude)"
agy plugin list
# live check needs an allow rule in $H/.gemini/antigravity-cli/settings.json:
#   {"permissions":{"allow":["command(echo porter-fixture-allow)"]}}
agy -p "Run exactly this shell command once: echo porter-fixture-allow" --print-timeout 120s
```

Hook payloads are appended to `%TEMP%\agy-porter-fixture.log` by `scripts/log-hook.mjs` in the fixture.
