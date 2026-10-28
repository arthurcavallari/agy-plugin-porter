# Phase 2.5 plan: Claude Code UI mods

This plan expands "Claude Code UI mods: spike, then decide" in [plan.md](./plan.md). A Claude Code UI mod is a JS/TS module listed in `hooks/hooks.json` as `{"modules":[...]}`. It runs inside Claude Code, hooks events with `on(...)`, calls the host through `$`, and draws element trees into render sites. Phase 2.5 decides whether such mods can run in Antigravity as plugin sidecars with a side-pane (aux pane) view, and builds the compiler only if they can.

Every claim below is labeled:
- **live**: seen on a running agy, in a throwaway home
- **static**: read from installed files or upstream source, never exercised

Static claims are the spike's job to confirm.

## 1. Where we start

Phases 0–2 are merged, and verified against agy 1.4.5:
- [`lib/detector.mjs`](../lib/detector.mjs) flags any hooks config with a `modules` key as a UI mod.
- [`lib/hook-compiler.mjs`](../lib/hook-compiler.mjs) compiles a hybrid file's classic `hooks`. Each module is reported as `ui-mod:<path>` with "Claude Code UI mods are not ported yet". The UI-mod `hooks/hooks.json` is not copied.
- [`lib/transpiler-engine.mjs`](../lib/transpiler-engine.mjs) removes the module files from the output, so unported mod code is never shipped.
- [`scripts/hook-shim.mjs`](../scripts/hook-shim.mjs) runs Claude-style hook commands under agy's contract. Exit 2 or a JSON decision becomes an agy decision, and any other failure fails open.

**Decision rules (unchanged from plan.md):**
- If step 0 fails, mods stay detect-and-report.
- If the spike's scorecard is negative, mods stay detect-and-report.
- The scorecard is reviewed before any compiler code is written.

## 2. What is established

### 2.1 Plugin sidecars in agy

| Fact | Evidence |
| :-- | :-- |
| `agy plugin validate` counts a plugin's `sidecars/<id>/sidecar.json` (`sidecars 1` for Google's `science` plugin) | live, 1.4.5 |
| `agy plugin install` copies `sidecars/<id>/sidecar.json` into the installed plugin | live, 1.4.5 |
| A plugin sidecar's view opens in the side pane, and a third-party plugin's sidecar starts after a restart | live, desktop 2.25.0: **yes**, step 0 passed (see [ui-mods-baseline.md](./ui-mods-baseline.md)) |

### 2.2 Google's reference: `science/sidecars/biomolecular_structure_viewer` (static)

Read from the installed `science` plugin (`~/.gemini/config/plugins/science/`).

**Manifest** (`sidecars/<id>/sidecar.json`):

```json
{
  "command": "node",
  "args": ["dist/server.cjs"],
  "description": "...",
  "display_name": "...",
  "has_web_ui": true,
  "restart_policy": "always",
  "ui_config": {
    "display_name": "...",
    "views": [{ "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE", "path": "/ui.html", "title": "..." }]
  }
}
```

**Companion MCP server** (`mcp_config.json`):
- It runs under `agy-node`, Antigravity's bundled Node: `"command": "agy-node"`, with `"args": ["sidecars/<id>/dist/mcp_entry.cjs"]`. The path is plugin-relative, with no `${PLUGIN_ROOT}`.
- It ships `"disabled": true`.

**Two processes:**
- `server.cjs` is the sidecar.
  - It serves `/ui.html`, `/api/events` (SSE), `/api/mutate`, `/api/notify` and `/mcp`.
  - It writes `server_info.json` (`host`, `port`, `token`) into its data directory.
  - It requires the token in an `X-Sidecar-Token` header.
- `mcp_entry.cjs` is the MCP server.
  - It reads `server_info.json` and forwards `tools/call` to `/mcp`.
  - If the sidecar isn't running, it patches state on disk (`mode: "offline"`).

**Finding the data directory:** `ANTIGRAVITY_EXECUTABLE_DATA_DIR` when set. Otherwise it searches `~/.gemini/<product>/sidecar_data/<plugin>/<sidecar>/data/`, where `<product>` is the CLI/desktop/IDE folder. A process that isn't the sidecar, such as a hook, can find the sidecar the same way.

**Conversations:**
- MCP calls carry `_meta["antigravity.google/conversation_id"]`.
- The server reads `ANTIGRAVITY_CONVERSATION_ID` and keeps per-conversation state under `~/.gemini/<product>/brain/<conversation-id>/scratch/`.
- `/api/notify` posts into a conversation through `agentapi` (`ANTIGRAVITY_AGENTAPI_EXE`).

### 2.3 Upstream mods (static, read from GitHub source on 2026-10-23)

| Mod | Files | Events | Notable `$` use |
| :-- | :-- | :-- | :-- |
| [`whyashthakker/awesome-claude-code-mods` `mods/task-board`](https://github.com/whyashthakker/awesome-claude-code-mods/tree/main/mods/task-board) | `register.js` (63 lines, 2.8 KB) + `ui.js`. Plain JS with `h()` helpers, no JSX, no `'claude-code'` import. | `session.start`, `command.run`, `ui.render` (Pane) | `$.store.{keys,get,set,delete}`, `$.clock.now`, `$.command.register`, `$.ui.{open,invalidate,resolve}` |
| [`hamzafer/claude-code-mods` `mods/replay-theater`](https://github.com/hamzafer/claude-code-mods/tree/main/mods/replay-theater) | `register.tsx` (181 lines, 6.6 KB). Imports `atom`/`read`/`update` from `'claude-code'`. | `session.start`, `turn.start`, `tool.call` ×2, `turn.complete`, `command.run`, `ui.render` (Pane only) | `$.fs.read`, `$.ui.{status,toast,open,close,resolve}`, `$.command.register` |
| [`xixiaofinland/side-pane`](https://github.com/xixiaofinland/side-pane) (`plugins/side-pane`) | `register.tsx` (232 lines, 9.5 KB). `'claude-code'` import. | `session.start`, `tool.describe`, `prompt.context`, `tool.call` ×2, `command.run`, `ui.render` (Pane), `ui.close` | `$.tool.register` declares `mcp__side-pane__update`/`clear`, which are **implemented in `on('tool.call', …)`** handlers returning `{ result }`. Also `$.prompt.fill` (its quote button drafts into the prompt box), `$.ui.{open,panes,toast,copy,close,resolve}`, `$.store`. |
| [`anthropics/claude-code-playground` `blast-radius`](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) | `blast-radius.mjs` (528 lines, 22.6 KB) | `tool.call` (Bash), `ui.render` (Pane, plus AbovePrompt when `!opened.isPlaced`) | Holds the tool call by looping on `$.process.run(["sleep", …])` until a button decides. `$.process.run` for dry-run inspection, `$.session.cwd`. |
| [`ray-amjad/claude-code-mods` `diagram-pane`](https://github.com/ray-amjad/claude-code-mods/tree/main/plugins/diagram-pane) | `register.js` (833 lines) + `draw.js` + `graph.js` | `session.start`, `turn.complete`, `tool.call` (its own `mcp__diagram-pane__*` tools), `command.run`, Pane | `$.model.complete` (Haiku gate), `$.model.fork`, `$.session.{id,messages}`. **Not a clean port.** |
| `code-modernization` (Anthropic, in the local `claude-plugins-official` cache) | `register.ts` (1,298 lines). Its `hooks/hooks.json` declares both `modules` and classic `hooks`. | Pane, AbovePrompt, PromptHint, `prompt.submit`, `tool.call`, … | `$.ui.blit`, `$.prompt.{fill,submit}`, `$.turn.abort` |

`blast-radius`'s own header comment says the host reads `on(...)` and `$.noun.method(...)` literally from source. That makes static capability discovery possible.

### 2.4 Requirements the runtime must meet (from 2.3, static)

1. **Module formats.** Mods ship as `.js`, `.mjs`, `.ts` and `.tsx`, with relative helper imports (`./ui.js`, `./draw.js`, `./lib/*`) that must be carried along.
2. **Components** come from `$.ui.resolve(e)` at render time, never from imports.
3. **`'claude-code'`.** TSX mods import `atom`, `read` and `update` from `'claude-code'`, so the runtime must provide that module.
4. **Placement.** Mods branch on `e.surface === 'desktop'` and on `$.ui.open(...).isPlaced`. The runtime reports `desktop` and `isPlaced: true`.
5. **Hold loops.** `$.process.run(["sleep", s])` is a hold loop and must become a timer, not a process.
6. **Mod-implemented tools.** A mod can declare a tool with `$.tool.register` and implement it in `on('tool.call', { tool: 'mcp__…' })` (`side-pane`, `diagram-pane`). Those handlers run inside the sidecar's MCP path, never as agy hooks; agy hooks don't match `mcp__*` names.
7. **Static scanning.** `on('…')` and `$.noun.method(…)` are spelled literally, so the compiler can list a mod's events and capabilities without running it.

## 3. Step 0: the go/no-go gate

The question is whether a third-party plugin's sidecar shows up in Antigravity at all. Everything after this depends on the answer, so answer it first with the smallest possible plugin: a hand-written `hello-pane` with one sidecar, one button and one MCP tool. No mod code is involved.

**Test environment.** Side-pane views only exist in the Antigravity desktop app; `agy -p` can't show them. The Phase 0 isolation (`HOME`/`USERPROFILE` at a scratch dir) is proven for the CLI only. Use one of these, in order of preference:
1. Windows Sandbox or a second Windows user, with Antigravity installed and signed in there.
2. The desktop app started with `HOME`/`USERPROFILE` overridden. Only use this after confirming the app really reads the override: hash-check the real `~/.gemini` before and after.

The real profile is never used.

**Questions, each answered live:**
1. After `agy plugin install` and a restart, does the sidecar start on its own? Or does it need enabling (`science` ships its MCP server `disabled: true`)?
2. Which id does the sidecar get (`<plugin>/<folder>`)? For marketplace installs the plugin directory can be a numeric hash; check whether the id and the data directory use that.
3. Where is the data directory, and is `ANTIGRAVITY_EXECUTABLE_DATA_DIR` set for the sidecar process?
4. Does a `[Open](sidecar://<plugin>/<id>/ui.html)` pill in a chat message open the view? Does a query string survive (for passing a conversation id)?
5. Is the sidecar one process for all conversations, or one per conversation? Is `ANTIGRAVITY_CONVERSATION_ID` set?
6. Does the view get `window.sidecar` (`agent.sendMessage`, `fetch`)? What CSP applies?
7. Can a hook process (`node scripts/x.mjs`) reach the sidecar over localhost using `server_info.json`?
8. Is `agy-node` on `PATH` for hooks too, or only for MCP servers?

**Exit criteria.** Questions 1, 3, 4 and 7 answered "yes, and here is how" is a **go**. Anything else stops Phase 2.5 at detect-and-report, recorded in `docs/ui-mods-baseline.md`.

## 4. Phase 2.5A: hand-port spike

Hand-port three real mods into plugins with `sidecars/<id>/`, using the runtime design in section 5 as written by hand, not generated. Each stage adds one hard problem.

| Stage | Mod | What it proves |
| :-- | :-- | :-- |
| 1 | `task-board` | Rendering Pane trees to HTML and redrawing over SSE. Button and Input round-trips. `$.store` persistence. `$.command.register` as a skill plus a pane button. Plain JS, so no build step. |
| 2 | `replay-theater` | `tool.call` observation through hooks, using the pause-and-resume model (5.2). `turn.start`/`turn.complete` mapping. `'claude-code'` atoms. The first TSX transform (5.8). |
| 3 | `side-pane` | Mod-implemented tools: `$.tool.register` to MCP to the mod's `tool.call` handler and back (requirement 6). `prompt.context` as injected context. `$.prompt.fill` fallback. |
| Stretch | `blast-radius` | A blocking PreToolUse held open until the user clicks. It blocks the agent loop and needs a hook timeout far above agy's 30 s default. Do it only if stages 1–3 go well. |

**Protocol:**
- Run everything in the step 0 environment.
- For each stage:
  - install it, and run `agy plugin validate --strict --json`
  - open the pill and drive the UI
  - run real agent turns that trigger the mod
  - stop the sidecar and repeat, to check fail-open
- Record results in `docs/ui-mods-baseline.md`: one row per render site, event, element and `$` noun, marked *works* / *partial* (with the fallback) / *not possible*, keeping live and static results apart.

**Gate.** The scorecard is reviewed before Phase 2.5B starts. It also states which real mods would port cleanly, which decides whether mod ports get registry entries in Phase 5.

## 5. Runtime design (validated by the spike, built in 2.5B)

### 5.1 Processes

| Piece | Runs as | Role |
| :-- | :-- | :-- |
| `sidecars/<id>/server.mjs` | The sidecar (`agy-node`) | Loads the transpiled mod and calls `register(on)` against the stand-in `$`. Serves `/ui.html`, SSE, UI actions, `/mcp` and `/api/hook`. Writes `server_info.json` like `science`. |
| `sidecars/<id>/mcp-entry.mjs` | MCP server from `mcp_config.json` | Exposes `$.tool.register` tools and one `slash_<command>` tool per command. Forwards calls to `server.mjs /api/mcp`. With the sidecar down, it lists the scanned tools and fails calls with a clear error. |
| `sidecars/<id>/hook.mjs` | agy hooks (`agy-node`) | Finds `server_info.json` (2.2) and POSTs the event to `/api/hook`. A separate forwarder, not an extended `hook-shim.mjs`: it's the path 2.5A proved live, classic ports keep a shim with no mod code, and the data-dir search would push the shim past 300 lines. |

### 5.2 `tool.call` is middleware, so pause and resume

In Claude Code a `tool.call` handler wraps the call: `const ran = await next(e)` runs the tool and returns its result. A handler can also:
- return `{ deny }` without calling `next`
- call `next({ ...e, command })` with changed input
- inspect `ran` after the tool runs

agy instead runs PreToolUse and PostToolUse as separate processes, and PostToolUse carries only `error`, never the tool's result (live). So the runtime:
1. **On PreToolUse:**
   - runs the handler until it returns or calls `next`
   - a return of `{ deny }` becomes a deny decision
   - `next(changed)` becomes an agy `overwrite` (supported by agy's contract, but not yet live-tested)
   - `next(e)` unchanged gives no opinion
   - the handler stays suspended inside `next`
2. **On PostToolUse:** resumes the suspended handler, keyed by conversation id and `stepIdx`. `next` resolves to `{ isError: Boolean(error), error }`. The spike records which result fields real mods read.
3. **Leaks:** suspended handlers are dropped at `Stop` or after a timeout, so lost PostToolUse events don't pile up.

Mod-implemented tools (requirement 6) skip this: the MCP path calls the handler directly and returns its `{ result }`.

### 5.3 Conversation scoping

- Claude's `$.state` and atoms are per session, but the sidecar serves every conversation. State is therefore keyed by conversation id, which comes from hook payloads, MCP `_meta` and possibly the environment (step 0, question 5).
- `$.store` stays per plugin and persistent, in the data directory.
- The view needs to know which conversation it shows; step 0 question 4 or 5 decides how. Until then it shows the most recently active conversation.

### 5.4 Event mapping

| Claude event | agy source | Notes |
| :-- | :-- | :-- |
| `session.start` | Sidecar start + `SessionStart` hook | Per conversation |
| `turn.start` | First `PreInvocation` after `SessionStart` or `Stop` | PreInvocation fires before every model call, so later ones in the same turn are ignored |
| `turn.complete` / `classic.Stop` | `Stop` | |
| `tool.call` (built-in tools) | `PreToolUse` + `PostToolUse` | Pause and resume, 5.2. Matchers come from [`lib/tool-map.mjs`](../lib/tool-map.mjs). |
| `tool.call` (own `mcp__*` tools) | MCP `tools/call` | Requirement 6 |
| `prompt.context` | The turn's first `PreInvocation`, `injectSteps` `systemMessage` | Partial: visible in the transcript, once per turn. `systemMessage` is the only step type proven live; an unknown type ends the agent turn. Needs a `Stop` hook to see turns end (live, 2.5B). |
| `tool.describe` | Tool description at registration | Static |
| `command.run` | Generated skill + pane toolbar button | Partial: agy skills can't run code |
| `prompt.submit`, `prompt.compose` | None | Reported, as in plan.md |

### 5.5 Render sites and `$` nouns

- **Pane:** rendered as HTML in the side-pane view and updated over SSE.
- **AbovePrompt / PromptHint:** shown as a header strip in the same view when the mod also has a Pane. A mod that only uses these gets a warning.
- **Transcript sites** (`UserMessage`, `AssistantMessage`, `ToolUse`, …): not possible. A mod that only targets them is refused.
- **Elements:**
  - `Box` is a flex container
  - `Text` is styled text, with ANSI converted to HTML
  - `Button`, `Input` and `Select` dispatch actions back to the server's callback table
  - `Code`, `Markdown` and `Divider` render as their HTML equivalents
  - `Svg` is sanitized
- **`$` APIs:**
  - **`$.ui.status/toast/notify/log`:** the view's status bar.
  - **`$.ui.copy`:** the clipboard.
  - **`$.prompt.fill`:** copies the text and shows "copied, paste it into the prompt". Never auto-sends, because sending is not drafting.
  - **`$.model.*`, `$.agent.*`, `$.ui.blit`, `$.ui.selection`, `$.session.messages`:** report, and return no-ops so optional features don't crash.

### 5.6 Capability gate and consent

A ported mod runs as a full Node process outside agy's permission prompts. Claude Code gates mods with its static scan, and the porter does the same:
- **Port report:** `mod-compiler` lists every `$.noun.method` the mod calls.
- **Tier:** any sidecar is at least Tier 2. `$.process.run`, `$.fs.write`, `$.http.*`, `tool.call` deny/overwrite or `$.prompt.*` make it Tier 3.
- **Runtime:** `$` exposes only the scanned methods; anything else throws.
- **Commands:** `$.process.run` takes an argument array (never a shell string), with the conversation's workspace as cwd.

### 5.7 Failure behavior

- Sidecar not running, unreachable, or the handler throws: the hook fails open (empty stdout, warning on stderr), matching Phase 2.
- MCP tools fall back to offline state like `science`. A mod-implemented tool whose handler needs the sidecar returns an MCP error that says so.

### 5.8 TS/JSX without runtime dependencies

The plugin that gets shipped stays dependency-free. Compilation happens at port time, on the porter's machine. The options:
1. **`esbuild` as an optional dependency of the porter**, loaded only when a source has TS/TSX modules. It's the most robust choice; real mods are up to 80 KB of TSX with generics.
2. **Node's `module.stripTypeScriptTypes`** (Node 22.13+/23.2+), plus a hand-written JSX pass. As far as we know it strips erasable TypeScript only, not JSX. Mods needing more are reported unported on older Node.

Hand-written TypeScript stripping with regexes is ruled out. The spike transforms all three stage mods with both options, and the scorecard picks one.

## 6. Phase 2.5B: compiler and runtime

Built; live results in [`ui-mods-baseline.md`](ui-mods-baseline.md#phase-25b-the-porters-own-output). Files stay ≤ 300 lines, and the porter keeps zero runtime dependencies (`esbuild` aside, 5.8).

```
lib/mod-lexer.mjs           # blanks comments, strings and regexes, keeping offsets
lib/mod-scan.mjs            # static scan (events, $ calls, commands, tools, render sites, imports),
                            # verdict (clean / partial / refused) and tier
lib/mod-transform.mjs       # optional esbuild: TS/TSX/JSX -> .mjs, import graph, 'claude-code' rewrite
lib/mod-compiler.mjs        # emits sidecars/<id>/, mod.json, mcp_config.json entry, skills, hooks.json entries
scripts/mod-runtime/        # copied flat into sidecars/<id>/, the mod into sidecars/<id>/mod/
  server.mjs  lifecycle.mjs  locate.mjs  engine.mjs  instance.mjs  elements.mjs  tool-calls.mjs
  claude-code.mjs  mcp-entry.mjs  hook.mjs  ui.html  ui.js  ui-draw.js
```

- **One sidecar per mod:** `pane` for a single module, `pane-<stem>` when a source lists several.
- **Visibility:** the view reports `document.visibilityState` plus a plain `IntersectionObserver` (`isIntersecting`). Only visible views count for `isPlaced`/`isShown`.
- **`$` allowlist:** the scan writes `mod.json`. A `$` call outside it throws. A scanned call the runtime doesn't implement rejects with "not available in the Antigravity port".

**Tests:**
- **Fixture:** `test/fixtures/claude-mod/` (one pane, one `tool.call` guard, one status line) compiles into a plugin that passes `agy plugin validate --strict` with `sidecars: 1`.
  - `server.mjs` on an ephemeral port renders `PORTER_FIXTURE_MOD_MARKER`.
  - A recorded PreToolUse payload containing `porter-fixture-deny` piped through the shim yields `{"decision":"deny",…}` and updates the pane count.
- **Negative fixture:** a mod that only targets `AssistantMessage` is refused with a clear reason.
- **Continuation unit tests:**
  - Pre then Post resumes the handler
  - a Pre with no Post is dropped at `Stop`
  - changed input becomes `overwrite`
- **End to end:** `bin/agy-porter.mjs` against the three stage mods (`--source <repo>@<sha> --path …`), each passing validate, with the spike plugins' behavior reproduced.

## 7. Related work outside this phase

- **Universal `mcp-apps-host` (Hangar).** It renders any MCP Apps (`ui://`), MCP-UI or OpenAI Apps SDK widget in the side pane. It builds on an open standard rather than Claude Code's fast-moving mod API, and the research ranks it P0. It reuses step 0's answers, so it can start once step 0 passes, in parallel with 2.5A. It's tracked in the hangar-backend repo (`docs/plugins-to-port/ui-mods-and-mcp-apps-catalog.md`), not here.
- **Generative-UI skills** (for example `tt-a1i/archify`, `nicobailon/visual-explainer`, trailofbits `review-walkthrough`). These are plain skills, so the Phase 1 porter may already port them. They're cheap registry candidates to check first.
- **Diagnostic fixtures** (`code-modernization`, transcript-only mods such as `NahumLitvin/prismantis`). These are compiler test inputs in 2.5B, not spike work.

## 8. Open questions

- Step 0 questions 1–8.
- Which `next()` result fields real mods read (5.2).
- Whether agy's `overwrite` works as documented, live. `deny` is live (2.5B); none of the stage mods rewrites input.
- ~~One sidecar per mod, or one host sidecar per repo~~: one sidecar per mod (2.5B).
- How fast Claude Code's mod API changes: pin the mod types version the runtime targets (`mods/types/claude-code.d.ts` in `anthropics/claude-code`).
