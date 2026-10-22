# Plan: `agy-plugin-porter` + plugin support in the Hangar registry

## Context

Hangar 1.1.0, sidecar-kit 1.1.0 and context-monitor 1.1.0 are released. The registry (`antigravity-sidecar-hub/registry.json`) still lists only `context-monitor`, which makes for a weak marketplace and blocks the workspace-trigger, sponsorship and Pro-sidecar ideas in docs 03/05.

The blueprint `antigravity-hangar-backend/docs/plugins-to-port/agy-plugin-porter.md` (Wave 1, P0) is the force multiplier. It turns Claude Code, Gemini CLI, Cursor, Roo/Kilo/Cline and Codex bundles into native Antigravity plugins, so dozens of existing plugins can be listed. Claude Code UI mods are in scope too, gated on a spike (see [Claude Code UI mods](#claude-code-ui-mods-spike-then-decide)). You chose to build the **full blueprint** in a **new repo, `agy-plugin-porter`**.

### Corrections to the blueprint (checked against Antigravity's own docs in `~/.gemini/antigravity/builtin/skills/{plugin,agy-customizations}`)
These override the blueprint wherever they conflict:
1. **Hook config shape differs.** Antigravity's `hooks.json` is keyed by *hook name* → event → `[{matcher, hooks:[{type,command,timeout}]}]`. Claude's is `{"hooks":{"PreToolUse":[...]}}`. Blueprint §4.6.7 copies `hooks/hooks.json` verbatim, which yields a hooks file Antigravity can't use. The compiler must restructure it.
2. **Tool names and matchers differ.** Antigravity uses names like `run_command`, `view_file` and `browser_*` (from `CORTEX_STEP_TYPE_*`). Claude uses `Bash`, `Read`, `Edit`, `Write`. The shim's map must cover both directions, and **matchers must be rewritten** too, not only payloads. Unmappable matchers are reported, not silently dropped.
3. **Not every event has an equivalent.** Antigravity has `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`. Claude's `UserPromptSubmit`, `Notification`, `SubagentStop` and `PreCompact` have no equivalent. They are reported as unported.
4. **Output contracts differ.** `SessionStart` and `PreInvocation` output uses `injectSteps` (`systemMessage` is a nested object). Claude's exit code 2 becomes `{"decision":"deny","reason":stderr}`. `Stop` blocking becomes `{"decision":"continue"}`.
5. **A plugin can contain a sidecar, at `sidecars/<id>/sidecar.json`.** *(Corrected 2026-10-22. An earlier version of this plan said it couldn't.)* Antigravity's official `science` plugin 1.3.0 ships `sidecars/biomolecular_structure_viewer/` with `has_web_ui: true` and a `SIDECAR_UI_ENTRYPOINT_AUX_PANE` view. The built-in `ui-plugin-navigation` skill lists `~/.gemini/config/plugins/<plugin>/sidecars/` as a sidecar root, with the id namespaced as `<plugin>/<folder>`. So blueprint §4.1's nesting is allowed. This matters for UI mods: a ported mod's pane can ship inside the plugin (see [Claude Code UI mods](#claude-code-ui-mods-spike-then-decide)). What's still **unverified** is whether `agy plugin install` copies `sidecars/` and whether `agy plugin validate` accepts it. The UI-mod spike checks both. Until then, Phase 4 keeps the cockpit as a separate sidecar. Hangar's `inspectSidecarDirectory` (`lib/package-installer.mjs:125`) requires `sidecar.json` at the root, so a standalone sidecar still needs a `release.path` subdirectory in the registry.
6. **`plugin.json` allows 7 keys only**: `name`, `displayName`, `description`, `version`, `logo` (a relative image path), `suggestedPrompts` (≤3) and `disabled`. Agents live at `agents/<name>.md` (the built-in plugin skill's layout; `agents/<id>/agent.md` also loads), with `tools` as a list of agy tool names and `model` as an agy tier (`pro`, `flash`, `flash_lite`, `inherit`). Anything else makes agy 1.4.x skip the agent.
7. **The platform already covers part of this.** `agy plugin import [gemini|claude]` and `agy plugin install <dir>` exist. `agy plugin validate <dir>` is a free correctness oracle, so use it in tests and CI. Phase 0 measures exactly what agy already handles, so the porter adds only the rest.

## Approach

### Distribution model: port at install time, never redistribute
Registry entries for ported plugins point at the **upstream repo, pinned to a tag or commit SHA**, plus a `port` block. Hangar clones the pinned upstream, runs the porter locally, audits the output and installs it. This avoids re-hosting third-party code (no license or attribution burden), stays reproducible thanks to the pin, and keeps the security audit on the user's machine.

---

### Phase 0: Benchmark `agy plugin import` / `install` against this plan (decision gate, ~1 day)
Goal: find out what agy 1.3.5 already does, so the porter only builds what's missing, and decide whether Hangar should call agy directly.

**Isolation.** `import` and `install` write plugin config, so every run uses a throwaway home. Point `USERPROFILE`, `HOME` and `GEMINI_CONFIG_DIR` (if agy honors it) at `<scratch>/home`, then confirm the real `~/.gemini/config/plugins` and `config.json` are byte-identical before and after (hash check). If agy ignores the overrides, run it in a disposable Windows Sandbox or VM instead, and never against the real profile.

**Fixtures** (also reused as porter test fixtures). Each one exercises a specific item in this plan:
- Claude plugin: `.claude-plugin/plugin.json` with `author`/`homepage`/`mcpServers`; `hooks/hooks.json` with PreToolUse `Bash` (exits 2), PostToolUse `Edit|Write`, SessionStart (stdout text) and `UserPromptSubmit`; `.mcp.json` with a generic `github` key and `${CLAUDE_PLUGIN_ROOT}`; `commands/*.md`; `agents/*.md`; `skills/x/SKILL.md`; `CLAUDE.md`.
- Gemini extension: `gemini-extension.json`, `commands/*.toml`, `GEMINI.md` and `hooks/hooks.json`.
- Cursor `.mdc` set (glob-scoped and `alwaysApply`), `.roomodes`, and Codex `.agents/skills`.
- A real upstream for comparison: `anthropics/claude-code` `plugins/hookify` (or one already cached under `~/.claude/plugins/marketplaces/claude-plugins-official`).

**Commands per fixture.** `agy plugin import claude` and `agy plugin import gemini` (with the fixture placed in the location import reads from, which `~/.claude/plugins/` will reveal), `agy plugin install <dir>` and `agy plugin validate <dir>`. Diff the staged plugin directory against the fixture.

**Scorecard** (`agy-plugin-porter/docs/agy-baseline.md`). One row per plan item: manifest sanitizing, hooks relocation, **hook shape restructure**, **matcher remap** (`Bash` → `run_command`), **payload and exit-2 translation** (live check: run the fixture hook through a real PreToolUse and see whether it denies), MCP prefixing and `${CLAUDE_PLUGIN_ROOT}` rewrite, commands → skills, Claude agents → `agents/<id>/agent.md`, `CLAUDE.md` → rules, and Cursor/Roo/Codex. Each cell is *agy handles* / *partial* / *not handled*.

**Decision rules applied to the rest of the plan:**
- Rows that agy fully handles are **deleted** from the porter's compilers. For Claude and Gemini sources the porter becomes a pre/post pass around `agy plugin install`: it fills gaps before install and audits after.
- If agy handles hooks end to end, Phase 2 (the hook shim) shrinks to a SessionStart/`injectSteps` adapter, or is dropped.
- If `agy plugin install <dir>` handles Claude/Gemini sources well, Hangar's `installRemotePlugin` calls agy for those, and runs `portPackage()` only for Cursor, Roo and Codex, or for gap-filling.
- `agy plugin import` itself (bulk-importing the user's existing Claude/Gemini installs) is a candidate **Hangar feature**: an "Import from Claude Code" button in Sideload that wraps import plus the porter's audit and gap-fill. It's added to Phase 3 only if the scorecard shows import works without the porter.

**Ongoing.** Add a differential test to porter CI: for the Claude and Gemini fixtures, compare the porter's output with `agy plugin install`'s staging (when agy is on the runner), so an agy upgrade that starts handling a gap shows up as a test diff.

### Phase 0 outcome (2026-10-22, see `agy-plugin-porter/docs/agy-baseline.md`)
- `import` and `install <dir>` run the same pipeline. `import claude` only scans `~/.claude/plugins/*` and misses real Claude Code installs, so **Hangar won't wrap it**.
- For Claude/Gemini sources, agy stages files well: skills, command → skill, `.mcp.json` → `mcp_config.json`, and hooks copied to the root. But it leaves **hooks in foreign shape (they never fire)**, `${CLAUDE_PLUGIN_ROOT}` unexpanded (hooks and MCP both dead), `CLAUDE.md` unported, and plain-text SessionStart dropped. It also mis-quotes hook commands on Windows.
- The runtime **already namespaces plugin MCP servers**, so `mcp-prefixed.mjs` is removed from scope. Its `${CLAUDE_PLUGIN_ROOT}` rewrite moves to `manifest-sanitizer.mjs`, and it becomes a rename to `${PLUGIN_ROOT}`, which agy expands in plugin MCP `args`/`env`/`cwd` (step 0, live).
- Cursor, Roo and Codex aren't detected by agy at all.
- **Step 0 re-run on agy 1.4.4/1.4.5** (same day, before Phase 1 code). JSON `{"decision":"deny"}` is confirmed live. `{}` from PreToolUse is a deny, so "no opinion" must be empty stdout. SessionStart must be flat, and PostToolUse failures no longer fail the tool. Claude agents are now skipped by the loader. See "Changes since 1.3.5" in the baseline.
- **Re-scope:** for Claude and Gemini sources the porter runs `agy plugin install` into a staging home, then post-processes the staged directory. It owns hooks, the shim, the MCP path fix, rules, frontmatter cleanup and the audit. For Cursor, Roo and Codex it builds the plugin directory itself. Phases 1–3 below are read with these changes.

### Phase 1: New repo `agy-plugin-porter` with the core compilers
Layout follows blueprint §4.2, with the cockpit moved out of the plugin. Node ≥20, ESM, zero runtime dependencies (frontmatter and TOML parsing done by hand, like the blueprint), `node --test`, ≤300 lines per file.

```
agy-plugin-porter/
  package.json            # bin: agy-porter; exports ./lib/index.mjs
  lib/detector.mjs        # which ecosystem(s) a dir contains; UI mods; manifest-less Claude plugins
  lib/manifest-sanitizer.mjs   # → 7-key plugin.json; rescues inline mcpServers;
                               # ${CLAUDE_PLUGIN_ROOT} → ${PLUGIN_ROOT} in MCP args/env/cwd
  lib/hook-compiler.mjs   # restructure + matcher remap + wrap commands with shim
  lib/skill-compiler.mjs  # cleans the skills agy made from commands; native and Codex skills
  lib/rules-compiler.mjs  # CLAUDE.md/GEMINI.md/AGENTS.md, .mdc, .cursorrules, Roo rules → rules/ (or skills/)
  lib/mode-compiler.mjs   # .roomodes/.kilocodemodes/Claude agents → agents/<name>.md
  lib/static-auditor.mjs  # Unicode tag strip (U+E0000–E007F), curl|sh / base64 / entropy flags,
                          # 24 KB per-rule + 20k-token aggregate budget, tier inference
  lib/transpiler-engine.mjs    # detect → stage (agy, throwaway home) → compile → audit → write
  lib/index.mjs           # public API: portPackage({srcDir, outDir, slug}) → {report, tier}
  lib/source.mjs          # local path, or owner/repo@ref fetched with git
  lib/tool-map.mjs        # Claude/Gemini/Roo tool names → agy tool names
  lib/yaml-lite.mjs       # YAML subset for frontmatter and .roomodes (no dependency)
  bin/agy-porter.mjs      # agy-porter --source <path|owner/repo@ref> [--path] [--slug] [--out]
                          #   [--validate] [--install] [--json]
  scripts/hook-shim.mjs   # runtime bridge, shipped INTO each ported plugin
                          # (with the compiler's scripts/hook-shim.json)
  test/fixtures/{claude,claude-mod,gemini,cursor,roo,codex,agy-probe}/
```
- **Port report.** Every run returns `{ported:[], unported:[{item, reason}], warnings:[], flags:[], tier}`. Nothing is dropped silently.
- **Rules budget.** `CLAUDE.md`, `GEMINI.md` and Codex's `AGENTS.md` become `rules/AGENTS.md` only if they fit the 24 KB per-rule limit. Cursor `.mdc` files map by kind:
  - `alwaysApply: true` → an `always_on` rule
  - description only → a `model_decision` rule (agy lists it with its description, live)
  - glob-scoped or manual → a skill (progressive disclosure). agy 1.4.5 never applies a plugin's `glob` or `manual` rules (live, on view and edit), even though `validate` accepts them.
- **Tier inference** reuses the meaning of Hangar's `TIER_*`: any hook or command execution means Tier 2, and subagent or cascade control means Tier 3.
- **UI-mod detection.** Claude Code UI mods use the same `hooks/hooks.json` file name as classic hooks, but in a different shape: `{"modules":["./register.tsx"]}`. The module is a TS/TSX file that runs inside Claude Code. `detector.mjs` flags any `hooks.json` with a `modules` key as a UI mod. `hook-compiler.mjs` must not treat that as a classic hook config. If a file has both `modules` and `hooks`, it compiles the `hooks` part and leaves `modules` alone. Each module is reported as `unported: {item: "ui-mod:<path>", reason: "Claude Code UI mods are not ported yet"}`. Nothing is copied or run. Phase 5's listing rule treats an unported UI mod like an unported hook, so a mod plugin isn't listed until a mod compiler exists. Add a `test/fixtures/claude-mod/` fixture: one pane, one `tool.call` hook and one status-line call.

### Phase 1 outcome (2026-10-22, agy 1.4.5)
Built as listed above. `npm test` runs 55 tests. The 7 that need agy (Claude/Gemini staging and `validate`) skip when it isn't on PATH. Every fixture's output passes `agy plugin validate` with no errors or warnings, apart from the probe's one intentional warning. Every run uses a throwaway home.
- **Live, in a throwaway home:**
  - the ported always-on rules from all five ecosystems reach context
  - the ported Claude agent and Roo modes appear as subagents
  - skills and MCP servers load, including the rescued inline one
  - a Cursor glob rule ported as a skill is chosen by its description
- **Real upstreams:** all 40 plugins in the local `claude-plugins-official` cache were ported. 28 pass `validate` with 0 errors. 2 of those have a validator warning, for a skill over 24 KB, which the report also flags. The other 12 are LSP-only entries with nothing to port.
- **Decisions beyond the plan:**
  - a Roo edit group restricted by `fileRegex` isn't granted, since agy can't scope edits, so it's reported rather than widened
  - Claude `opus`/`sonnet` map to `pro` and `haiku` to `flash`
  - `PostToolUseFailure` maps onto agy's PostToolUse, with the shim gating on agy's `error` field
  - manifest-less Claude plugins get a stand-in manifest for staging
  - UI-mod module files are removed from the output
- **Dependency on agy:** Claude and Gemini sources need `agy` on PATH, per the re-scope. Cursor, Roo and Codex sources don't.

### Phase 2: Hook shim (`scripts/hook-shim.mjs`)
- Invocation: `node scripts/hook-shim.mjs --event PreToolUse --hook <id>`, cwd-relative and unquoted. agy mangles quoted arguments on Windows and doesn't expand variables in hook commands, so nothing from the original command goes on agy's command line. The compiler writes each original command to `scripts/hook-shim.json` under its id. The shim expands `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${extensionPath}` and `${/}` itself, then spawns the command through Node's shell, which quotes correctly. That makes spaces and quotes in the original command safe, so they don't need rejecting. The shim sets `CLAUDE_PLUGIN_ROOT` to the plugin root (its own parent directory) and `CLAUDE_PROJECT_DIR` to `workspacePaths[0]`.
- A nonzero exit other than 2, a timeout or a failed spawn never blocks: the shim allows the call (Claude and Gemini semantics) and writes a warning to stderr. agy only logs that stderr at info level in `cli-*.log` (live), so neither the user nor the model sees it. The shim itself always exits 0, because agy fails closed on any nonzero PreToolUse exit.
- Stdin translation is camelCase → snake_case (`toolCall.name` → `tool_name` via the reverse tool map, `args` → `tool_input` with key renames such as `CommandLine` → `command`, `conversationId` → `session_id`, `transcriptPath` → `transcript_path`).
- Output translation: exit 0 with JSON (Claude's `hookSpecificOutput.permissionDecision`, `decision:block`) maps to the Antigravity decision. Exit 0 with no output means empty stdout for PreToolUse ("no opinion": the normal permission flow runs) and `{}` for the others. The shim never prints `{}` for PreToolUse, because agy reads that as a deny. Exit 2 means `deny` (or `continue` for Stop) with stderr as the reason. Stdout text on SessionStart becomes an `injectSteps` systemMessage.
- Windows: spawn with `shell:true` only for the wrapped command, never for the shim. The shim strips the BOM and normalizes CRLF.

### Claude Code UI mods: spike, then decide
A Claude Code UI mod is a TS/TSX module listed in `hooks/hooks.json` as `{"modules":[...]}`. It exports `register(on, options)` and runs inside Claude Code. It hooks events (`tool.call`, `prompt.submit`, `prompt.compose`, `command.run`, `ui.render`, `session.start`) and calls the host through `$` (`ui`, `state`, `store`, `tool`, `command`, `agent`, `model`, `fs`, `process`, `clock`). It draws host element trees (`Box`, `Text`, `Button`, `Markdown`, `Code`, `Image`, …) into **render sites**, on the terminal, desktop, VS Code and mobile surfaces. Antigravity has no matching module API. Its closest UI target is a plugin sidecar with a side-pane (aux pane) web view (correction #5). This phase runs after Phase 2, because a mod's `tool.call` hooks depend on the hook shim. Like Phase 0, it starts with a spike and a scorecard before any compiler code is written.

**Spike: hand-port two mods, then write a scorecard (`docs/ui-mods-baseline.md`).**
- Pick a pane-only mod: a `Pane` drawn by `ui.render`, with buttons and `$.state`. Pick a mixed mod too: a pane plus a `tool.call` guard, a status-line entry and a slash command. Prefer real mods. The `test/fixtures/claude-mod/` fixture from Phase 1 is the fallback.
- Port each by hand into a plugin with `sidecars/<id>/sidecar.json` (`has_web_ui: true`, an `SIDECAR_UI_ENTRYPOINT_AUX_PANE` view). The sidecar's node server:
  - loads the transpiled module and calls `register()` against a stand-in `$`
  - renders the element tree to HTML, and routes button presses and input back to the mod's handlers
  - keeps `$.state`/`$.store` in the sidecar's own storage
  - exposes registered tools over MCP
- Everything runs in a throwaway home, as in Phase 0. Check that:
  - `agy plugin install` copies `sidecars/`
  - `agy plugin validate` accepts it
  - the sidecar starts after a restart, under the id `<plugin>/<folder>`
  - its panel opens from a `sidecar://` pill
  - the pane redraws when state changes
- Record each render site and `$` noun as *works* / *partial* / *not possible*, with evidence. Live-tested and static-only results stay labeled separately.

**Expected render-site mapping.** This is unverified: it comes from Claude Code's mod reference and Antigravity's built-in skill docs, and the spike confirms or corrects it.

| Mod feature | Antigravity target | Expectation |
| :-- | :-- | :-- |
| `Pane` (`$.ui.open` + `ui.render`) | Side-pane web view of a plugin sidecar | Likely. Needs the element-tree → HTML runtime. |
| `$.state` / `$.store` | The sidecar's own storage | Likely |
| `$.tool.register` | An MCP server in the plugin (stdio, or served by the sidecar) | Likely |
| `$.command.register` + `command.run` | Skills | Partial. Skills are static, while mod commands are registered at runtime and answered in code. |
| `tool.call` | `PreToolUse`/`PostToolUse` through the hook shim | Partial. Deny should work. Rewriting the call or reading its result in-process probably won't. |
| `prompt.compose` | `PreInvocation` + `injectSteps` | Unknown. Adding a section might work, but replacing or dropping one won't. |
| `prompt.submit` | None (no `UserPromptSubmit` event, correction #3) | Not possible |
| `AbovePrompt` band | None found | Not possible. Could fall back to the pane. |
| Transcript sites (`UserMessage`, `CommandOutput`, tool-call rows) | None found. `<agent-embed>` is created by the model, not by plugins. | Not possible |
| `$.ui.status`, `$.ui.toast`, `$.ui.notify` | None found | Not possible. Could show inside the pane. |
| `$.agent`, `$.model`, `$.fs`, `$.process`, `$.clock` | Node APIs inside the sidecar. Agent and model calls have no known equivalent. | Partial |

**Constraints to settle in the spike.**
- **TSX needs a transpile step.** Node can strip TypeScript types, but it can't compile JSX. That conflicts with the porter's zero-runtime-dependency rule. Options:
  - transpile at port time with an optional dependency (for example `esbuild`), used only when a source has `modules`
  - write a small JSX-to-`h()` pass by hand

  The runtime that ships into the ported plugin stays dependency-free either way.
- **Surface.** A ported mod gets `e.surface === "desktop"` and the desktop element table. Elements the runtime can't draw are refused, with a port-report warning.
- **Tier.** A mod runs as a full Node process in the sidecar, with `fs` and `process` access, so it is always at least Tier 2. The static auditor scans the module source like hook scripts.

**Decision rules.**
- If the pane round trip works, a later phase adds `lib/mod-compiler.mjs` and `scripts/mod-runtime/`. That phase ports panes, state, tools and guard hooks, and reports every other site as unported.
- If it doesn't work, for example because agy won't install or start plugin sidecars, mods stay detect-and-report only (Phase 1).
- Either way, the scorecard says which real mods would port cleanly. That decides whether mod ports earn registry entries in Phase 5.

### Phase 3: Hangar integration (repo `antigravity-sidecar-hub`)
- **Registry schema.** Add `kind: "sidecar" | "plugin"` (default `"sidecar"` for backward compatibility), `release.path` (subdirectory), `release.ref` (tag or SHA; **required** when `port` is set), and `port: { from: "claude"|"gemini"|"cursor"|"roo"|"codex"|"auto" }`. Update `scripts/validate-registry.mjs`, `test/registry-schema.test.mjs` and doc 04 §3 in the backend repo.
- **Installer.** Add `installRemotePlugin()` in a new `lib/plugin-installer.mjs` (keeps `package-installer.mjs` under 450 lines). It reuses `materializeRemotePackage`, `parseGitRepoSpec` and `swapIntoPlace`, then:
  1. Runs `portPackage()` from the `agy-plugin-porter` dependency when `port` is set; native plugins skip this step.
  2. Requires `report.tier` and the audit flags to pass the **existing consent flow** (Tier 2/3 confirmation, `hasLifecycleScripts`).
  3. Installs with `agy plugin install <outDir>`, falling back to copying into `~/.gemini/config/plugins/<id>` if Phase 0 shows agy can't install it.
  4. Enables via LS `JetboxWriteState` (`userConfig.plugins.<dir>.enabled`), never by editing `config.json`.
  5. Returns `restartRequired: true`, because new plugin directories are only discovered on startup.
- **Uninstall** uses LS `DeletePlugin`. It re-enables a disabled plugin first so a stale `enabled:false` entry can't break a reinstall (the gotcha documented in plugin/SKILL.md).
- **Installed state** reads LS `GetAllPlugins`, always reduced to `{name, dir, disabled, counts}` and never returned as raw SKILL.md text. Wire it into `lib/state-orchestrator.mjs` alongside `GetSidecars`, using the shared LS reader from the 1.1.0 perf work.
- **API.** `server.mjs` gains `/api/store/install-plugin`, `/api/store/uninstall-plugin` and `/api/store/port-preview`. The preview runs the porter in dry-run mode and returns the report so the UI can show what will and won't port before consent.
- **UI.** `ui/components/marketplace-panes.js` and `extensions-tab.js` get a "Plugin" badge, a ported-from badge, a port-report disclosure on the consent dialog, a restart-required notice, and an Installed list section for plugins. Plugins don't get tabs because they have no iframe.

### Phase 4: Native packaging of the porter (in `agy-plugin-porter`)
- `plugin/` is the installable plugin: `plugin.json`, `rules/AGENTS.md` (porting invariants), `skills/port-competitor-plugin/SKILL.md`, `agents/plugin-migration-engineer/agent.md`, a `hooks.json` SessionStart detector (`scripts/session-start.mjs` injects a systemMessage when the workspace holds an unported `.claude-plugin`, `.roomodes` or `.cursor/rules`), and an `mcp_config.json` stdio server `agy-plugin-porter_cli` exposing `port_preview` and `port_install` over the same `lib/index.mjs`.
- `cockpit/` is the separate sidecar (`sidecar.json`, `hub-manifest.json`, `server.mjs` on `antigravity-sidecar-kit`, and a `ui/` of index.html, styles.css and app.js per blueprint §4.8). You enter a path or repo, it shows the port report diff, and an install button runs the port.
- Publish `agy-plugin-porter` to npm. Hangar adds it as a dependency, and `TRUSTED_FIRST_PARTY_SDKS` gets the name so it doesn't inflate the external-dependencies count.

### Phase 5: Seed the registry
- Add the porter itself: `kind:"plugin"` with `release.path:"plugin"`, plus the cockpit as `kind:"sidecar"` with `release.path:"cockpit"`.
- Add the three Wave-1 P0 ports, each pinned to an upstream SHA: `trailofbits-security` (`trailofbits/skills`, Claude), `anthropic-core-workflows` (`anthropics/claude-code` `plugins/*`, Claude) and `roo-boomerang-modes` (Roo modes). The `anthropics/claude-code` monorepo needs `release.path` per plugin, so the same field covers it.
- Each entry must port with zero unported *hooks* (unported commands are acceptable) and pass `agy plugin validate`. If one doesn't, it isn't listed.

## Critical files
- This repo, `agy-plugin-porter` (everything above).
- Hangar: `lib/plugin-installer.mjs` (new), `lib/package-installer.mjs` (export the shared helpers), `lib/state-orchestrator.mjs`, `lib/registry-catalog.mjs` (handle `kind`/`port` in catalog merge and updates), `scripts/validate-registry.mjs`, `server.mjs`, `ui/components/marketplace-panes.js`, `ui/components/extensions-tab.js`, `registry.json`, `package.json`.
- Backend docs: `docs/04-schemas-and-contracts.md` (registry `kind`/`port`/`release.path|ref`), `docs/plugins-to-port/agy-plugin-porter.md` (add a "Corrections" note linking to `docs/agy-baseline.md`), and `docs/05` (status).

## Verification
1. `agy-plugin-porter`: `npm test` passes on all five fixture ecosystems. Each fixture's output passes `agy plugin validate <out>`. Hook-shim tests pipe recorded Antigravity payloads (from hooks.md) through a Claude-style script that exits 0, exits 2, and emits JSON, then assert the stdout contract.
2. CLI end-to-end: `agy-porter --source trailofbits/skills@<sha> --slug trailofbits-security --out <scratch>`, then `agy plugin validate`, then inspect the report.
3. Live: install via Hangar's Discover tab, restart Antigravity, and confirm with `GetAllPlugins` (filtered through jq) that the skills, agents and hooks appear. Trigger a ported PreToolUse hook (for example a ported `Bash` guard on `run_command`) and confirm that deny and allow both work. Uninstall and confirm `DeletePlugin` ran and a reinstall comes back enabled.
4. Hangar: `npm test`, including new tests for `plugin-installer` (with mocked `rpcFn` and porter) and the registry schema with `kind`/`port`. `npm run validate:registry` passes, and CI (`test.yml`) passes.
5. Regression: existing sidecar install, update and uninstall still work (an entry with no `kind` defaults to sidecar).

## Rollout
**Phase 0's scorecard comes first and is shared before any compiler code is written.** Phases 1–3 are re-scoped from it.

Ship it as separate PRs in this order:
1. Porter phases 0–2 with an npm `0.x` release. This includes UI-mod detection, but not porting.
2. The Hangar registry schema and plugin installer (Hangar 1.2.0).
3. The porter's native plugin and cockpit (phase 4).
4. The registry seed (phase 5).

The UI-mod spike runs after step 1, in parallel with step 2. Its scorecard is shared before any mod compiler code is written, like Phase 0's. If it says go, the mod compiler ships as its own porter PR before the registry seed (step 4).

Each PR can be reviewed and reverted on its own.
