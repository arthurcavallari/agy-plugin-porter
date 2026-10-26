# UI mods baseline

This is the scorecard for Phase 2.5 (see [phase-2.5-ui-mods-plan.md](./phase-2.5-ui-mods-plan.md)). It starts with step 0, the go/no-go gate. The Phase 2.5A spike results get added below it.

Every claim is labeled, as in the plan:
- **live**: seen on the running Antigravity desktop app, with log lines or files as evidence
- **static**: read from installed files or source, never exercised

## Step 0: does a plugin sidecar run in the desktop app?

**Verdict: go.** Questions 1, 3, 4 and 7 are all "yes, and here's how" (live).

**Run.** 2026-10-23, Antigravity desktop 2.25.0 (language server `hub-2.25.0`), `agy` CLI 1.4.5, Windows 11. Sidecar and MCP processes ran on the app's bundled Node, v24.21.0. Times below are local (UTC+11).

**Environment.** This run used the real profile, not the throwaway environment that plan §3 asks for. That was a deliberate choice by the profile owner, with these safeguards:
1. The app was closed and both `%USERPROFILE%\.gemini` and `%APPDATA%\Antigravity` were backed up first, with a SHA-256 manifest of every file. The copy was verified against it.
2. Every change went through `agy plugin install`/`uninstall` or the app's own UI. No config file was edited by hand.
3. After the uninstall, both folders were compared with the manifest. See [Cleanup](#cleanup).

**Fixture.** [`test/fixtures/hello-pane/`](../test/fixtures/hello-pane/), plugin `porter-step0-hello`, contains:
- one sidecar, `sidecars/hello/` (`sidecar.json`, a zero-dependency `server.mjs`, `ui.html`)
- one stdio MCP server, `sidecars/hello/mcp.mjs`, with the tools `hello_status` and `hello_bump`
- one PreToolUse hook on `run_command`, `scripts/hook.mjs`, which always prints nothing and exits 0
- one skill that emits the `sidecar://` pills

Every process logs what it receives (`ANTIGRAVITY_*` variables with secrets redacted, cwd, pid, `_meta`, payloads) into the sidecar's data directory. The view reports its URL, `window.sidecar`, CSP violations and host messages back to the server.

**Validate and install.**
- `agy plugin validate --strict --json` reports `sidecars 1, mcpServers 1, hooks 1, skills 1`, 0 errors and one warning: `command "agy-node" … isn't on this machine's PATH`. Google's `science` plugin gets the same warning. The validator checks the PATH of the shell it runs in, and `%APPDATA%\Antigravity\bin` isn't on the user's PATH. The app's processes have it (question 8).
- `agy plugin install` printed `[ok]` and copied `sidecars/hello/` whole. It also updated `config/import_manifest.json`, and left `config.json` alone until the app started.

### Answers

| # | Question | Answer | Evidence | Label |
| :-- | :-- | :-- | :-- | :-- |
| 1 | After install and a restart, does the sidecar start on its own? How is it enabled? | **Yes, no enabling step.** It started with the app. It's tied to the plugin: the app has no separate toggle for plugin sidecars. Switching the plugin off in **Customizations > Plugins** stops the sidecar and the MCP server at once. Switching it on starts them again, without a restart. | `logs/sidecar.log`: `=== sidecar "porter-step0-hello/hello" started at 2026-10-23T11:25:37+11:00 ===`. The plugin shows as **Enabled** under **Customizations > Plugins**. Its sidecar is absent from **Customizations > UI Extensions**, which lists standalone sidecars only. Off/on: `config.json` `plugins.porter-step0-hello.enabled` false/true, and `sidecar_manager.go:642] Config changed for sidecar porter-step0-hello/hello, updating...` at 13:27:08 and 13:30:08, with a new process and gateway after the second. | live |
| 2 | Which id does the sidecar get? Does it use the install folder name? | **`porter-step0-hello/hello`**, that is `<plugin name>/<sidecar folder>`. The install folder is named after `plugin.json` `name` (`config/plugins/porter-step0-hello`), not after the source folder (`hello-pane`). | `ANTIGRAVITY_SOURCE_METADATA` = `{"sidecar":{"sidecarId":"porter-step0-hello/hello",…}}`. The `config.json` key is `sidecars["porter-step0-hello/hello"]`. The LS log says `Sidecar porter-step0-hello/hello gateway listening on …`. The view's origin is `plugin://porter-step0-hello--hello-<port>`. | live (local-dir install) |
| 2b | Same for marketplace installs? | Probably the same. `science`, installed from the marketplace, lives at `config/plugins/science` with id `science/biomolecular_structure_viewer`. No numeric-hash folder was seen. | `config.json`, `config/plugins/` | static |
| 3 | Where is the data directory? Is `ANTIGRAVITY_EXECUTABLE_DATA_DIR` set? | **`~/.gemini/antigravity/sidecar_data/porter-step0-hello/hello/data`, and yes**, for the sidecar process. The host also writes the sidecar's console output to `…/hello/logs/sidecar.log`, with a banner per start. The MCP server and hooks **don't** get the variable. They found the directory by searching `~/.gemini/*/sidecar_data/<plugin>/<sidecar>/data`, as `science`'s `mcp_entry.cjs` does. | Sidecar `start` log: `dataDirFrom: ANTIGRAVITY_EXECUTABLE_DATA_DIR`. MCP and hook logs: `dataDir.from: "search:antigravity"`. | live |
| 4 | Does a `sidecar://` pill open the view? Does a query string survive? | **Yes and yes.** The agent emitted `[Open hello pane](sidecar://porter-step0-hello/hello/ui.html)` from the skill. Clicking it opened the side pane on `/ui.html?token=<host token>&conversationId=<the pill's conversation>`. With `ui.html?conv=porter-step0-conv-marker`, the server got `?token=…&conversationId=…&conv=porter-step0-conv-marker`: the host puts its own parameters first and keeps ours. A pill reloads the view only when its URL differs from the open one. Repeat clicks on the same pill did nothing. | Sidecar request log at 11:40:32 and 11:56:19, and the view's `page` report (`convParam: "porter-step0-conv-marker"`) | live |
| 5 | One sidecar process for all conversations, or one per conversation? Is `ANTIGRAVITY_CONVERSATION_ID` set? | **One process for all conversations**, and one MCP server process too. `ANTIGRAVITY_CONVERSATION_ID` is **not set** for the sidecar or the MCP server. It **is set** for hook processes. A conversation is identified by the view URL's `conversationId`, by MCP `_meta["antigravity.google/conversation_id"]` and by the hook payload's `conversationId`. | PID 79736 served views from conversations `d20afc3b-…` and `55c28716-…` and both conversations' MCP calls (MCP PID 66896). The hook env lists `ANTIGRAVITY_CONVERSATION_ID`. | live |
| 6 | Does the view get `window.sidecar`? What CSP applies? | **Not from the host.** `window.sidecar` doesn't exist until the page loads `/preload.js` from its **own** server. The fixture serves the SDK's copy from `$ANTIGRAVITY_APP_DATA_DIR/lib/node_modules/sidecar_sdk/preload.js`, as `science` does. After that it has `conversationId`, `fetch`, `getWorkspaceUris`, `onWorkspaceChange`, `agent.{sendMessage,startConversation,getConversationMetadata}` and `ui.{toggleAuxPane,toggleConversation}`. **No restrictive CSP** was seen: inline script and `eval` run, there's no CSP meta and no `securitypolicyviolation`. The page is a secure context with origin `plugin://porter-step0-hello--hello-<port>`, framed by `https://127.0.0.1:<ui port>`. | The view's `page` reports: `sidecarBeforePreload: false`, members after preload, `evalAllowed: true`, `violations: []` | live |
| 6b | Does `agent.sendMessage` work? | Only if the sidecar implements it. `preload.js` POSTs `agent.*` to `/_sidecar/send-message`, `/_sidecar/new-conversation` and `/_sidecar/get-conversation-metadata` on the sidecar's own server. The SDK and `science` answer those with `$ANTIGRAVITY_AGENTAPI_EXE agentapi …`. The fixture doesn't implement them, so this wasn't exercised. preload's own `get-conversation-metadata` call got a 404. | `sidecar_sdk/index.mjs`, `preload.js` | static |
| 7 | Can a hook reach the sidecar through `server_info.json`? Does `/api/hook` see real `run_command` events? | **Yes.** `node scripts/hook.mjs PreToolUse` (cwd = plugin root, system `node`) found `server_info.json` by searching, and POSTed with a 2 s timeout (`HTTP 200 from 127.0.0.1:51341`). The sidecar got the real event, and the open view updated over SSE. | Sidecar `hook` entry at 12:52:15: `toolCall` `{name: "run_command", args: {CommandLine: "echo porter-step0-hook", WaitMsBeforeAsync, toolSummary}}`, with `conversationId`, `stepIdx`, `modelName`, `transcriptPath`, `artifactDirectoryPath` and `workspacePaths` | live |
| 8 | Is `agy-node` on PATH for hooks, or only for MCP servers? | **For both**, and for sidecars too. The app puts `%APPDATA%\Antigravity\bin` on its child processes' PATH. It isn't on the user's own PATH. | Hook: `where agy-node` → `C:\Users\…\AppData\Roaming\Antigravity\bin\agy-node.cmd`. MCP: `"command": "agy-node"` ran as `cmd.exe /c agy-node …/mcp.mjs`. Sidecar: the same PATH entry, plus `ANTIGRAVITY_NODE_PATH=…\agy-node.cmd`. | live |

### Also checked

| Item | Result | Label |
| :-- | :-- | :-- |
| MCP tools with the pane closed | Work. `hello_status` and `hello_bump` returned with the pane closed, and the sidecar answered both. | live |
| Sidecar after closing the pane | Keeps running (same PID before and after). | live |
| `restart_policy: "always"` | After the sidecar process was killed, the LS logged `Sidecar porter-step0-hello/hello exited with error: … exit status 0xffffffff`, then `Retrying sidecar … in 1 seconds...`. A new process started on a **new port with a new token** within about 1 s. Other policy values weren't tested. | live |
| Sidecars when the app quits | **They keep running.** On all three quits, every sidecar process (this one and the standalone ones) outlived the app. The MCP server and the language server exited. No signal reaches the server, so `server_info.json` stays behind, stale. The next launch starts a new instance on a new port. No orphan exited on its own while watched (3+ minutes). Google's `science/biomolecular_structure_viewer` does the same: after a quit at 14:25:44 it was still serving on its port 4 minutes later, alongside its `cmd.exe` wrapper, and its `server_info.json` was left behind. Its MCP server, which runs over stdio, exited with the app. Turning the plugin off kills the process too, also without a signal, but that path does clean it up. | live |
| Why they outlive the app | On quit, the app's `killLanguageServer()` calls `proc.kill('SIGTERM')` on the language server. On Windows, Node turns that into an immediate forced kill, so the language server never gets to stop its sidecars. The graceful path (closing stdin for `--exit_on_stdin_close`) is used only for WSL. Windows doesn't kill child processes with their parent, so each `cmd.exe /c agy-node.cmd` wrapper and the `Antigravity.exe` Node process under it keep running. The ported runtime should exit by itself once `ANTIGRAVITY_LS_ADDRESS` stops answering. A `process.ppid` check won't work, because the parent `cmd.exe` stays alive too. `science`'s `server.cjs` only cleans up on `SIGINT`/`SIGTERM`, which Windows never delivers, and it has no language-server check. | static (`resources/app.asar`, `server.cjs`), matching the live result above |
| Windows job objects | The language server **is** in a kill-on-close job: the one Node/libuv creates in the app's main process (flags `0x3C00`), whose only members are the app and the language server. That job also sets `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so every process the language server starts leaves it automatically. The language server holds no job handle of its own, so its sidecars (and their `cmd.exe` wrappers) are in no job tied to it. Each sidecar's Node process only holds its own libuv job for its own children. A kill-on-close job created by the language server for its sidecars would make Windows clean them up on any exit, crash included. | live (job handles read with `NtQuerySystemInformation` + `QueryInformationJobObject`, checked against a test job) |
| How a sidecar is launched | `"command": "node"` runs `cmd.exe /c %APPDATA%\Antigravity\bin\agy-node.cmd --import=file:///…/sidecar_sdk/register_loader.js server.mjs`. That is `Antigravity.exe` with `ELECTRON_RUN_AS_NODE=1`, cwd = the sidecar folder. `register_loader.js` only maps the bare `sidecar_sdk` import. The port comes from `ANTIGRAVITY_SIDECAR_WEB_PORT`. A per-sidecar gateway on another loopback port proxies to it. | live |
| Sidecar environment | `ANTIGRAVITY_AGENTAPI_EXE`, `_APP_DATA_DIR`, `_CSRF_TOKEN`, `_EXECUTABLE_DATA_DIR`, `_LS_ADDRESS`, `_LS_VERSION`, `_NODE_PATH`, `_PROJECT_ID` (a per-sidecar project), `_SIDECAR_UI_TOKEN`, `_SIDECAR_WEB_PORT` and `_SOURCE_METADATA` (the parsed `sidecar.json` plus `sidecarId`). The MCP server got **no** `ANTIGRAVITY_*` variables. | live |
| MCP handshake | The client sends `server/discover` (protocol `2026-07-28`) first. A server that answers "method not found" then gets a normal `initialize`. `tools/call` `_meta` also carries `antigravity.google/artifacts_dir` and a `progressToken`. | live |
| Host messages to the view | `theme-change` `{theme, themeType, cssVariables}` and `workspace-change` `{workspaceUris}`, posted once per load. In 4 of 29 rapid pill toggles neither arrived, and the view stayed on preload's light fallback (`#fafafa`). Hangar, when it embeds a view, also posts `sidecar-visibility` `{visible}`. | live |
| View with no conversation | The view also loaded with no `conversationId`, for example 2 s before a new conversation's pill load. | live |
| Per-sidecar `enabled` flag | `sidecars["porter-step0-hello/hello"].enabled: false` in `config.json` **didn't stop** the plugin sidecar. `restart_policy` restarted it, and it started on the next launch. Hangar most likely wrote that flag through the app (see below). A standalone sidecar with the same flag (Docker Ops) stayed stopped. | live |
| Uninstall | `agy plugin uninstall` removes the plugin folder and `plugins.<name>`, but leaves `sidecars["<plugin>/<id>"]` (with its `projectId`) in `config.json`. | live |

**Hangar side effect.** At 11:30:52, while the view was open inside Hangar, Hangar added the plugin sidecar to `config/hangar.json` as `scope: "project"` with `autoHibernate: true`, and `layout.pinnedTopSidecarId` changed to it. At 13:05:24, `config.json` gained the ignored `enabled: false` above. Nobody toggled it by hand. Hangar's `hibernation-manager.mjs` sends `SIDECAR_ACTION_DISABLE` for auto-hibernate sidecars that don't match the active workspace after `hibernateAfterIdleMinutes` (10). That's the likely writer. It's inferred from Hangar's source and the config writes, not traced live. Hangar should treat plugin sidecars as plugin-controlled. That fix belongs in the Hangar repo, not here. (Fixed in Hangar 1.2.1: plugin sidecars never hibernate, and switching one off goes through the plugin's own switch.)

### What this changes in the Phase 2.5 plan

- **Go for 2.5A.** Hand-port the stage mods into plugin sidecars as planned.
- **5.3 conversation scoping is settled.** The view gets its conversation from `?conversationId=`, MCP calls from `_meta`, and hooks from the payload and `ANTIGRAVITY_CONVERSATION_ID`. The runtime must still handle a view with no conversation; see [Conversation identity](#conversation-identity) for what that means.
- **`window.sidecar` is the runtime's job.** It has to serve `/preload.js`, loaded in `<head>` like `science` does so the host's one-shot `theme-change` isn't missed, and implement `/_sidecar/*` through `agentapi` if mods need it. It also needs its own light/dark fallback for lost theme messages.
- **Treat `server_info.json` as possibly stale.** Orphans and hard kills leave it behind, and every restart changes the port and token. Callers re-read it on every call and fail open on a connection error (2 s timeout). The fixture does both, and that worked.
- **Exit when the language server is gone.** On Windows, quitting the app hard-kills the language server and orphans every sidecar. The runtime should poll `ANTIGRAVITY_LS_ADDRESS` and exit when it stops answering, so ported mods don't pile up across restarts.
- **Hooks could run on `agy-node`**, so ported plugins wouldn't need a system Node. That's a candidate change for the Phase 2 shim, still to be tested.
- **The plugin toggle is the on/off switch.** Hangar's Phase 3 work should enable and disable plugins, not plugin sidecars.

### Reproduce

1. Close the app, then back up `~/.gemini` and `%APPDATA%\Antigravity`. Or use a throwaway Windows user, per plan §3.
2. `agy plugin validate --strict --json test/fixtures/hello-pane`, then `agy plugin install test/fixtures/hello-pane`.
3. Start the app. In a conversation, send "Open the hello pane" and click both pills. Send "Run this shell command: echo porter-step0-hook". Close the pane, then ask for `hello_status` and `hello_bump`. Repeat from a second conversation.
4. Read `~/.gemini/antigravity/sidecar_data/porter-step0-hello/hello/data/{hello,mcp,hook}.log` (JSON lines) and `../logs/sidecar.log`. Host lines are in `%APPDATA%\Antigravity\logs\language_server.log` (`sidecar_manager.go`, `gateway.go`).
5. Close the app, stop any leftover `Antigravity.exe … register_loader.js` processes, then run `agy plugin uninstall porter-step0-hello` and delete `sidecar_data/porter-step0-hello`.

### Cleanup

After `agy plugin uninstall porter-step0-hello` and deleting `sidecar_data/porter-step0-hello`, both folders were hashed again and compared with the pre-install manifest.

**Left behind by the test plugin** (the app's, not removed by uninstall):
- `config.json` `sidecars["porter-step0-hello/hello"]`, and its project file `config/projects/<projectId>.json` (`name: "porter-step0-hello/hello"`)
- `antigravity/mcp/porter-step0-hello_hello/{hello_status,hello_bump}.json`: the MCP tool cache. Caches for other removed plugins' servers stay there too.
- In Hangar's own `config/hangar.json`, the sidecar's entry and `layout.pinnedTopSidecarId`

**Expected churn from using the app:**
- the two test conversations (`brain/`, `conversations/`, `annotations/`, `presence/`)
- conversation summaries and app state
- the other sidecars' `events/`, `runtime.json` and `logs/`
- crash-log rotation
- a marketplace cache refresh
- Chromium caches and storage under `%APPDATA%\Antigravity`
- Docker Ops `enabled: false`, from Hangar's hibernation of a project-scoped sidecar

`config/import_manifest.json` and `config.json` `plugins` match the backup again.

**Unexpected: 23 old conversations were deleted.** They were the 23 oldest (last written 2026-09-28/29), with their `brain/` folders and one browser recording. The profile held 521 conversations before the test. Adding the 2 test conversations and removing 23 leaves exactly 500. The language server has a `max_conversations` setting, so the app most likely prunes history to the newest 500 when conversations are added. That's inferred from the counts and the binary, not traced in a log. They're intact in the backup. Anyone repeating this on a real profile with more than 500 conversations should expect it.

## Conversation identity

**Question.** How does a sidecar view know which conversation is selected? Hangar and Context Monitor used to rank conversations by the language server's `lastUserViewTime` and pick the newest, which kept showing the wrong conversation after a switch.

**Run.** 2026-10-25/26, Antigravity desktop 2.26.0, Windows 11. Static results come from the app's UI bundle, which the language server serves as `main.js` (the `app.asar` is only a thin Electron shell), and from the language server binary's strings. Live results come from the app's DevTools target list (`%APPDATA%\Antigravity\DevToolsActivePort`, then `/json/list`), which shows every sidecar iframe with its full URL, plus read-only `Runtime.evaluate` in those frames.

| Finding | Evidence | Label |
| :-- | :-- | :-- |
| **One iframe per conversation.** The sidecar view appends the focused conversation (`?focused=` from the `/c/<ids>` route) to the sidecar URL as `conversationId`, and keeps iframes per URL. A switch shows a different iframe. The old one stays mounted with `visibility: hidden`. | Bundle: `conversationId:OR()` in the sidecar view component, iframes registered per URL, `cleanupConversationSidecarIframes`. Live: with two conversations open, one Hangar frame per conversation (`conversationId=7899a1c7…` and `…=40cfdb13…`), each with a Context Monitor child carrying the same id. After switching away and back, each frame still showed its own conversation's title. | live |
| **The app never tells a view about a switch.** It posts only `theme-change` and `workspace-change`. `window.sidecar.conversationId` is read once from the URL and never changes. There's no `onConversationChange`. | `conversation-change` appears nowhere in the bundle, `app.asar` or the language server. The preload template is embedded in the language server binary. | static |
| **`lastUserViewTime` can't tell the previous conversation from the next.** On every switch the app calls `UpdateConversationAnnotations{cascadeIds:[prev, next]}` with one timestamp. The next one is stamped only if the window has focus. | Bundle: the `conversationViewing` middleware. Live: after a switch, the two conversations had the same `lastUserViewTime`, and a no-id guess picked the other one. | static, with a live symptom |
| **No API answers "which conversation is focused".** No language-server RPC returns it (all 352 `LanguageServerService` methods checked), and nothing on disk stores it per window. `UserSettings.lastSelectedCascadeId` is one global value. `displayedRootConversationId` exists only on the internal agent-browser subscription. | Language server strings, `app_storage.json`, `~/.gemini/antigravity/` | static |
| **The new-conversation screen opens views with no `conversationId` at all**, on the home route (`/?section=outside-of-project`). | Live: the Hangar and Context Monitor frames opened there had no `conversationId` parameter. | live |
| **`_new` is the app's placeholder for a pane without a conversation yet** (default layout `cascadeId:"_new"`, helper `a!=="_new"`). It wasn't seen in a host-built view URL. Hangar now passes it to its own child views to mean "new conversation". | Bundle | static |

**What a view should do.**
- The `conversationId` the frame was opened with **is** its conversation. A visible frame is the focused conversation, and `IntersectionObserver` sees the hidden ones leave the viewport.
- Inside a host frame (`window.parent !== window`), a missing id or `_new` means there's no conversation yet. Show an empty state, not another conversation's data.
- Only a standalone browser tab, with no host, has to guess from view times.
- One sidecar process serves every window. Keep no per-poll "previous answer" state on the server: polls from different windows would mix it up.

**Where it's implemented.**
- `antigravity-sidecar-kit` 1.3.0: `resolveActiveWorkspace` returns the frame's own id, and `isRealConversationId` / `NEW_CONVERSATION_ID` are exported.
- Context Monitor 1.2.0 and 1.2.1: follows the frame's id, and shows "No conversation yet" on a new-conversation view.
- Hangar 1.2.1 and 1.2.2: each Hangar frame keeps its own id and passes it, or `_new`, to its child views.

Live after those releases: on the new-conversation screen with Hangar's tab open, Hangar's frame had no id, its Context Monitor child got `conversationId=_new` and showed the empty state, while the two conversations' frames kept showing their own titles.

## Phase 2.5A spike

**Verdict: go for 2.5B, with the limits below.** All three stage mods run as Antigravity plugin sidecars from their unchanged upstream source. task-board and replay-theater port cleanly. side-pane ports partially: Antigravity can't open a pane by itself, and it has no hidden per-prompt context.

**Run.** 2026-10-26, Antigravity desktop 2.26.0 (language server 2.26.0), `agy` CLI 1.4.5, Windows 11. Sidecars, hooks and MCP servers ran on the app's bundled Node, v24.21.0. Times from `runtime.log` are UTC. Times from `language_server.log` are local (UTC+11).

**Environment.** The real profile again, with step 0's safeguards. With the app closed, both folders were copied to `backups\spike2.5a-20261026-1454` and hashed. Every file matched except the `cli.log` symlink, which robocopy can't copy without admin rights. Installs went through `agy plugin install`/`uninstall`, and the on/off switch through **Customizations > Plugins**. The edits ran in a throwaway workspace, `C:\Users\arthu\spike-scratch`.

**What was built.** [`spike/`](../spike/README.md) holds each mod's upstream source at a pinned commit, plus a hand-written runtime, the design in plan §5:
- `server.mjs` + `engine.mjs` run the mod's `register(on)` against a stand-in `$`. Each conversation gets its own module instance, so module variables and `$.state` are per conversation, like Claude Code's per-session state.
- The view (`ui.html`) draws the element trees and posts clicks back. A toolbar has one button per registered command.
- `hook.mjs` forwards SessionStart, PreInvocation, PreToolUse, PostToolUse and Stop to the sidecar.
- `mcp-entry.mjs` serves `$.tool.register` tools, plus one `slash_<command>` tool per command. A generated skill per command calls that tool.

`spike/smoke.mjs` replays agy's side offline, 21 checks per run. Every check passed under system Node and the app's Node.

| Plugin | Mod source | Validate (`--strict --json`) |
| :-- | :-- | :-- |
| `porter-spike-task-board` | `whyashthakker/awesome-claude-code-mods` `c53a70b`, `mods/task-board` | `sidecars 1, mcpServers 1, hooks 1, skills 1` |
| `porter-spike-replay-theater` | `hamzafer/claude-code-mods` `fd249d5`, `mods/replay-theater` | same |
| `porter-spike-side-pane` | `xixiaofinland/side-pane` `66fe8a1`, `plugins/side-pane` | same |

`--strict` passes once `%APPDATA%\Antigravity\bin` is on PATH. Without it, it fails only on step 0's known `agy-node` warning.

### Scorecard

*works* runs as in Claude Code. *partial* runs with the fallback shown. *not possible* has no Antigravity equivalent.

**Render sites and elements**

| Item | Result | Evidence | Label |
| :-- | :-- | :-- | :-- |
| Pane | **works**. It draws in the sidecar's view and redraws over SSE. | All three panes, read from the app's frames through DevTools | live |
| `Box`, `Text` (nested, `bold`, `dimColor`, `color`, `wrap`) | **works** | replay-theater's diff and step strip, task-board's frame | live |
| `Button` (`label` or children, `plain`, `variant`, `hotkey`) | **works**, hotkeys included once the pane has focus | Toggle, Delete, Prev, Next, copy, quote, and **n**/**p** | live |
| `Input` (`onSubmit`) | **works** | task-board added tasks | live |
| `Markdown` | **works**, with a small renderer (headings, lists, code, bold, links) | side-pane's lunch options | live |
| `Code`, `Divider`, `Select` | Drawn, but none of the three mods uses them | `ui.html` | static |
| AbovePrompt, PromptHint, transcript sites | Not exercised. None of the three mods uses them. | Plan §5.5 stands | static |

**Events**

| Claude event | Antigravity source | Result | Label |
| :-- | :-- | :-- | :-- |
| `session.start` | First contact for a conversation (hook, view or MCP call) | **works**. The cwd comes from the hook's `workspacePaths`. A cwd learned later reruns `session.start`, as a Claude Code reload does. | live |
| `turn.start` | First PreInvocation after SessionStart or Stop | **works** | live |
| `turn.complete` | Stop | **works**. replay-theater's toast fired once per turn. | live |
| `tool.call`, built-in tools | PreToolUse + PostToolUse, pause and resume (plan §5.2) | **works** for observing. PostToolUse carries the same `stepIdx` and args as its PreToolUse, so every handler resumed by `stepIdx`. `next()` resolves to `{ isError }` from `error`. A Pre with no Post is dropped at Stop. | live (drop: offline) |
| `tool.call` `{ deny }` / changed input | PreToolUse `deny` / `overwrite` | Implemented, but none of the three mods does it, so it wasn't exercised | static |
| `tool.call`, the mod's own tools | MCP `tools/call` to the sidecar | **works**. The agent called side-pane's `update`, and the handler's `{ result }` came back as the tool result. A `{ deny }` becomes an MCP error. | live (deny: offline) |
| `tool.describe` | Applied at `tools/list` | **partial**. agy cached `update` with the mod's full description. `isDeferred` has no equivalent and is ignored. | live |
| `prompt.context` | PreInvocation `injectSteps` | **partial**. Only `systemMessage` works, and it shows in the transcript as "Hook Json PreInvocation" on **every** model call (10 for 4 turns). Claude's context is hidden and once per prompt. | live |
| `command.run` | A generated skill calls the `slash_<name>` tool. Also a toolbar button in the view. | **partial**. Both paths ran the handler. The skill path costs a model turn, and its reply carries a `sidecar://` link to open the pane. | live |
| `ui.close` | The view's own tab close (×) | **partial**. Closing Antigravity's own pane tab sends the sidecar nothing, so the mod never hears about it. | live |

**`$` nouns**

| API | Result | Label |
| :-- | :-- | :-- |
| `$.ui.resolve`, `$.ui.invalidate` | **works** | live |
| `$.ui.open` | **partial**. The pane exists in the runtime, but only the user can show it: a `sidecar://` link or the pane's tab. A server can't open a view, and `window.sidecar.ui.toggleAuxPane` only toggles the whole side panel. | live |
| `$.ui.close` | **works**, within the view | live |
| `$.ui.panes` | **partial**. `isPlaced`/`isShown` count connected views. Hangar embeds every sidecar view in every conversation, so a hidden copy keeps them true. | live |
| `$.ui.toast` | **works** in the view. It isn't seen when no view is open. | live |
| `$.ui.status` | Implemented (status bar). Not reached live: replay-theater calls it only from the second turn on. | static |
| `$.ui.copy` | **works**. The clipboard write succeeded inside the view's frame, after the click's round trip. | live |
| `$.prompt.fill` | **partial**. It copies the text and says "paste it into the prompt box". It never drafts or sends. | live |
| `$.store` | **works**. It's per plugin and persistent (`store.json` in the data dir). task-board's keys are per workspace. | live |
| `$.state` and `'claude-code'` `atom`/`read`/`update` | **works**. They're per conversation, and a write redraws the pane. | live |
| `$.clock.now`, `$.fs.read`, `$.session.cwd`, `$.command.register`, `$.tool.register` | **works** | live |
| Anything else | Rejects with "not available in the Antigravity port". Unawaited calls can't crash the sidecar. | static |

### Other findings

| Finding | Evidence | Label |
| :-- | :-- | :-- |
| **An unknown `injectSteps` type ends the whole agent turn.** A guessed `hookEphemeralMessage` step gave `unknown injected step type: <nil>`. Because PreInvocation runs before every model call, that broke every conversation until the plugin was switched off. The runtime must only emit step types proven live. | Agent error and `language_server.log`, 16:45:55 | live |
| **The desktop app uses the CLI's tool names:** `write_file {Path, Content, Overwrite}` and `edit_file {Path, Target, Replacement}`, not `write_to_file`/`replace_file_content`. | Hook payloads | live |
| **Hooks run on `agy-node`.** `agy-node sidecars/pane/hook.mjs <Event>` worked for all five events. Ported plugins don't need a system Node. | Hook log | live |
| **`a\|b` matchers work.** `write_to_file\|write_file\|…` matched `write_file` and `edit_file`. | Hook log | live |
| **Hooks fail open.** With the sidecar unreachable (`server_info.json` pointing at a dead port, and earlier with the file missing), each hook printed "no opinion", logged `porter spike hook: fetch failed; not blocking`, and the turn ran normally. | `notes.txt` gained `delta`; `command_hook_executor.go` stderr lines | live |
| **An orphan can delete its replacement's `server_info.json`.** After a quit, the old side-pane sidecar noticed the language server was gone 2 s after its replacement started, and removed the new file. The MCP tool then reported "sidecar not running". Fixed: a sidecar removes the file only if it still holds its own pid. | `runtime.log` 07:06:43 and 07:06:45 (UTC) | live |
| **`agy plugin uninstall` fails while the plugin's sidecar runs.** On Windows the sidecar's cwd is its own folder, so the uninstall stops with "plugin is in use by another process". It has already deleted the files by then, and the plugin is gone from `config.json`. Empty folders stay behind, and the next `install` fails until they're removed. Switching the plugin off first avoids it. | `agy` output, `language_server.log` 18:43 | live |
| **A reinstall is picked up live.** With the app running and the plugin switched off, `agy plugin uninstall` then `install` started the new sidecar build (`Config changed for sidecar …`) with no restart or toggle. | `language_server.log` 17:49:48 | live |
| **The model may pick a native tool over a mod's tool.** Asked for options, Gemini used Antigravity's own question widget rather than side-pane's `update`, even with the nudge injected. It called `update` only when asked to. | Transcript | live |
| **Hook round trips are cheap.** The sidecar answered every hook in 0–1 ms. Each hook still costs a Node process start. | `runtime.log` `ms` | live |

### TS/TSX transform (plan §5.8)

Both options transformed both TSX mods, and the pane trees they produced were identical, compared at the end of every offline scenario.
- **`esbuild`** (`jsx: transform`, factory `h`, fragment `Fragment`): no changes needed.
- **`module.stripTypeScriptTypes` plus a hand-written JSX pass** ([`spike/jsx.mjs`](../spike/jsx.mjs), about 140 lines): `stripTypeScriptTypes` rejects JSX, so the pass has to run first. It needed two bug fixes for these two files alone (nested JSX inside expressions, and template literals). It still can't handle generic arrow functions in `.tsx`.

**Pick: `esbuild` as an optional dependency of the porter**, loaded only for TS/TSX mods. The hand-written pass is too fragile for the 80 KB mods in the catalog. Mods that need a transform are reported unported when `esbuild` is missing.

### Which mods port

| Mod | Verdict | Registry entry (Phase 5) |
| :-- | :-- | :-- |
| task-board | Clean | Yes |
| replay-theater | Clean. Its own `relative()` splits paths on `/`, so Windows shows full paths. | Yes |
| side-pane | Partial: no auto-open, visible piling context, and a model that may prefer its native question tool | Not yet |

### What this changes for 2.5B

- **`prompt.context`:** emit `systemMessage` once per turn (the first PreInvocation), never per call, and report the mapping as partial. Keep looking for a hidden step type, but only ship one that is proven live.
- **Placement:** report `isPlaced: false` until a *visible* view is connected. The view reports `document.visibilityState` plus an `IntersectionObserver` result. Command results carry a `sidecar://` link to open the pane.
- **Uninstall:** switch the plugin off (or stop its sidecar) before `agy plugin uninstall`. This applies to the porter's docs and to Hangar's uninstall path.
- **`server_info.json`:** a sidecar deletes it only while it still holds its own pid.
- **Tool map:** the desktop app's tool names match the CLI's. The shim's existing map covers them.
- **Commands:** keep both paths: a skill that calls `slash_<name>`, and the view's toolbar. Label the argument field, with the command's `argumentHint` as help text rather than the only text.
- **Transform:** `esbuild` as an optional dependency (above).

### Reproduce

1. Close the app and back up both folders (see step 0).
2. `node spike/build.mjs --esbuild <path>/node_modules/esbuild`, `node spike/smoke.mjs`, then `agy plugin validate --strict --json` and `agy plugin install` for each `spike/out/porter-spike-*`.
3. Start the app in a throwaway workspace. Run `/task-board <task>`, edit a file and run `/replay`, then ask the agent to "use the side-pane update tool" to list options. Open each `sidecar://` link and use the panes.
4. Read `~/.gemini/antigravity/sidecar_data/porter-spike-*/pane/data/runtime.log`. The app's own frames are listed at `http://127.0.0.1:<DevToolsActivePort>/json/list`.
5. To uninstall, switch each plugin off in **Customizations > Plugins** first, then `agy plugin uninstall porter-spike-<mod>`.

### Cleanup

The three plugins were switched off, uninstalled with `agy plugin uninstall` (clean this time), and their `sidecar_data` folders deleted. With the app closed, both folders were hashed again and compared with the pre-install manifest.

**Left behind by the spike plugins** (the app's and Hangar's, not removed by uninstall, as in step 0):
- `config.json` `sidecars["porter-spike-<mod>/pane"]` for all three, and their project files `config/projects/<projectId>.json`
- `antigravity/mcp/porter-spike-*`: the MCP tool cache (5 files)
- In Hangar's `config/hangar.json`, side-pane in `layout.topSplitTabIds`, and `layout.pinnedTopSidecarId` moved from `context-monitor` to `porter-spike-side-pane/pane`. Hangar wrote this while the view was open, as it did in step 0. It now points at a sidecar that no longer exists.

**Expected churn from using the app:**
- the four test conversations (`brain/`, `conversations/`, `annotations/`, `presence/`) and the `spike-scratch` project
- conversation summaries, app state, the Hangar and Context Monitor data, crash logs, a marketplace cache refresh, an `android-cli-plugin` update, and Chromium caches under `%APPDATA%\Antigravity`

**Old conversations pruned again.** The profile held 508 conversations before the run. Adding the 4 test conversations removed the 12 oldest (last written 2026-09-29), which leaves exactly 500. That matches step 0's inference that the app keeps the newest 500. The 12 are intact in the backup.
