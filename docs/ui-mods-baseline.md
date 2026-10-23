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

**Hangar side effect.** At 11:30:52, while the view was open inside Hangar, Hangar added the plugin sidecar to `config/hangar.json` as `scope: "project"` with `autoHibernate: true`, and `layout.pinnedTopSidecarId` changed to it. At 13:05:24, `config.json` gained the ignored `enabled: false` above. Nobody toggled it by hand. Hangar's `hibernation-manager.mjs` sends `SIDECAR_ACTION_DISABLE` for auto-hibernate sidecars that don't match the active workspace after `hibernateAfterIdleMinutes` (10). That's the likely writer. It's inferred from Hangar's source and the config writes, not traced live. Hangar should treat plugin sidecars as plugin-controlled. That fix belongs in the Hangar repo, not here.

### What this changes in the Phase 2.5 plan

- **Go for 2.5A.** Hand-port the stage mods into plugin sidecars as planned.
- **5.3 conversation scoping is settled.** The view gets its conversation from `?conversationId=`, MCP calls from `_meta`, and hooks from the payload and `ANTIGRAVITY_CONVERSATION_ID`. The runtime must still handle a view with no conversation.
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
