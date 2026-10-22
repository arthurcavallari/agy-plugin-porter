# Plan: `agy-plugin-porter` + plugin support in the Hangar registry

## Context

Hangar 1.1.0, sidecar-kit 1.1.0 and context-monitor 1.1.0 are released. The registry (`antigravity-sidecar-hub/registry.json`) still lists only `context-monitor`, which makes for a weak marketplace and blocks the workspace-trigger, sponsorship and Pro-sidecar ideas in docs 03/05.

The blueprint `antigravity-hangar-backend/docs/plugins-to-port/agy-plugin-porter.md` (Wave 1, P0) is the force multiplier. It turns Claude Code, Gemini CLI, Cursor, Roo/Kilo/Cline and Codex bundles into native Antigravity plugins, so dozens of existing plugins can be listed. You chose to build the **full blueprint** in a **new repo, `agy-plugin-porter`**.

### Corrections to the blueprint (checked against Antigravity's own docs in `~/.gemini/antigravity/builtin/skills/{plugin,agy-customizations}`)
These override the blueprint wherever they conflict:
1. **Hook config shape differs.** Antigravity's `hooks.json` is keyed by *hook name* → event → `[{matcher, hooks:[{type,command,timeout}]}]`. Claude's is `{"hooks":{"PreToolUse":[...]}}`. Blueprint §4.6.7 copies `hooks/hooks.json` verbatim, which yields a hooks file Antigravity can't use. The compiler must restructure it.
2. **Tool names and matchers differ.** Antigravity uses names like `run_command`, `view_file` and `browser_*` (from `CORTEX_STEP_TYPE_*`). Claude uses `Bash`, `Read`, `Edit`, `Write`. The shim's map must cover both directions, and **matchers must be rewritten** too, not only payloads. Unmappable matchers are reported, not silently dropped.
3. **Not every event has an equivalent.** Antigravity has `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`. Claude's `UserPromptSubmit`, `Notification`, `SubagentStop` and `PreCompact` have no equivalent. They are reported as unported.
4. **Output contracts differ.** `SessionStart` and `PreInvocation` output uses `injectSteps` (`systemMessage` is a nested object). Claude's exit code 2 becomes `{"decision":"deny","reason":stderr}`. `Stop` blocking becomes `{"decision":"continue"}`.
5. **A plugin cannot contain a sidecar.** Blueprint §4.1 nests `sidecars/transpiler-cockpit/` inside the plugin directory, which Antigravity doesn't support. The cockpit ships as a **separate sidecar** from the same repo. Hangar's `inspectSidecarDirectory` (`lib/package-installer.mjs:125`) requires `sidecar.json` at the root, so the registry needs a `release.path` subdirectory.
6. **`plugin.json` allows 7 keys only**: `name`, `displayName`, `description`, `version`, `logo` (a relative image path), `suggestedPrompts` (≤3) and `disabled`. Agents live at `agents/<id>/agent.md` with frontmatter, as in `~/.gemini/config/plugins/antigravity-help/agents/agy-help/agent.md`.
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
- The runtime **already namespaces plugin MCP servers**, so `mcp-prefixed.mjs` is removed from scope.
- Cursor, Roo and Codex aren't detected by agy at all.
- **Re-scope:** for Claude and Gemini sources the porter runs `agy plugin install` into a staging home, then post-processes the staged directory. It owns hooks, the shim, the MCP path fix, rules, frontmatter cleanup and the audit. For Cursor, Roo and Codex it builds the plugin directory itself. Phases 1–3 below are read with these changes.

### Phase 1: New repo `agy-plugin-porter` with the core compilers
Layout follows blueprint §4.2, with the cockpit moved out of the plugin. Node ≥20, ESM, zero runtime dependencies (frontmatter and TOML parsing done by hand, like the blueprint), `node --test`, ≤300 lines per file.

```
agy-plugin-porter/
  package.json            # bin: agy-porter; exports ./lib/index.mjs
  lib/detector.mjs        # which ecosystem(s) a dir contains
  lib/manifest-sanitizer.mjs   # → 7-key plugin.json; extracts mcpServers/hooks
  lib/mcp-prefixed.mjs    # server keys → <slug>_<key>; rewrite ${CLAUDE_PLUGIN_ROOT}
  lib/hook-compiler.mjs   # restructure + matcher remap + wrap commands with shim
  lib/skill-compiler.mjs  # commands/*.toml, commands/*.md, .mdc → skills/<id>/SKILL.md
  lib/mode-compiler.mjs   # .roomodes/.kilocodemodes/Claude agents → agents/<id>/agent.md
  lib/static-auditor.mjs  # Unicode tag strip (U+E0000–E007F), curl|sh / base64 / entropy flags,
                          # 24 KB per-rule + 20k-token aggregate budget, tier inference
  lib/transpiler-engine.mjs    # detect → compile → audit → write to out dir; returns report
  lib/index.mjs           # public API: portPackage({srcDir, outDir, slug}) → {report, tier}
  bin/agy-porter.mjs      # agy-porter --source <path|owner/repo@ref> --slug <s> [--out] [--install]
  scripts/hook-shim.mjs   # runtime bridge, shipped INTO each ported plugin
  test/fixtures/{claude,gemini,cursor,roo,codex}/
```
- **Port report.** Every run returns `{ported:[], unported:[{item, reason}], warnings:[], tier}`. Nothing is dropped silently.
- **Rules budget.** `CLAUDE.md` and `GEMINI.md` become `rules/AGENTS.md` only if they fit the budget. Glob-scoped `.mdc` files become skills (progressive disclosure), and only `alwaysApply: true` files go to rules.
- **Tier inference** reuses the meaning of Hangar's `TIER_*`: any hook or command execution means Tier 2, and subagent or cascade control means Tier 3.

### Phase 2: Hook shim (`scripts/hook-shim.mjs`)
- Invocation: `node ${PLUGIN_DIR}/scripts/hook-shim.mjs --event PreToolUse -- <original command>`. The working directory is the plugin root (per hooks.md), so the shim sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` (from `workspacePaths[0]`).
- Stdin translation is camelCase → snake_case (`toolCall.name` → `tool_name` via the reverse tool map, `args` → `tool_input` with key renames such as `CommandLine` → `command`, `conversationId` → `session_id`, `transcriptPath` → `transcript_path`).
- Output translation: exit 0 with JSON (Claude's `hookSpecificOutput.permissionDecision`, `decision:block`) maps to the Antigravity decision. Exit 0 with no output means `allow` for PreToolUse and `{}` for the others. Exit 2 means `deny` (or `continue` for Stop) with stderr as the reason. Stdout text on SessionStart becomes an `injectSteps` systemMessage.
- Windows: spawn with `shell:true` only for the wrapped command, never for the shim. The shim strips the BOM and normalizes CRLF.

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
- New repo: `C:\Users\arthu\IdeaProjects\agy-plugin-porter\` (everything above).
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
1. Porter phases 0–2 with an npm `0.x` release.
2. The Hangar registry schema and plugin installer (Hangar 1.2.0).
3. The porter's native plugin and cockpit (phase 4).
4. The registry seed (phase 5).

Each PR can be reviewed and reverted on its own.
