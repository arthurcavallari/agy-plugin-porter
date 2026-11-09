# Porter plugin baseline

This is the live-validation record for Phase 4 (see [plan.md](./plan.md#phase-4-outcome-2026-10-29)): the porter packaged as its own Antigravity plugin, with the cockpit sidecar inside it.

> [!NOTE]
> **Since this run, the cockpit has been rebuilt on `antigravity-sidecar-kit` (2026-11-09).** Its pane now uses the kit's native components (fields, cards, badges, banners) and the host's theme, and it confirms installs in an inline consent bar instead of a dialog. The build bundles the kit into the plugin's `node_modules`.
> - **Checked with the agy CLI in a throwaway home, not in the app:** `agy plugin install` keeps that `node_modules` folder, and `agy plugin validate --strict` passes on the build.
> - **Live:** the run below used the earlier, dependency-free cockpit and its dialog, so its rows describe that version.

Every claim is labeled, as in [ui-mods-baseline.md](./ui-mods-baseline.md):
- **live**: seen on the running Antigravity desktop app, with log lines or files as evidence
- **static**: read from installed files or source, never exercised

## Run

**Verdict: the plugin works end to end in the app, after two fixes found during the run.** The detector, the agent's consent flow, the cockpit's preview and install, and a pinned GitHub source all worked live. Two bugs turned up and were fixed and rechecked in the app: GitHub sources failed under the app's Node, and the agent ran a preview nobody asked for.

**When and what.** 2026-10-29, Antigravity desktop 2.28.0, `agy` CLI 1.4.5, Windows 11. The cockpit and MCP server ran on the app's bundled Node, v24.21.0. Times below are local (UTC+11).

**Build.** `npm run build:plugin` at commit `b9825a6`, then a rebuild at `e01f0e2` with both fixes, used for the recheck. Later commits weren't live-tested. `4bf38dc` changed the compilers, the hook shim, `plugin/scripts/session-start.mjs` and the cockpit's `ui.js`, and passes the offline tests. The installs used the built folder `dist/plugin/agy-plugin-porter`, not a release tarball. Hangar installing it from a `tarballUrl` wasn't tested.

**Environment.** The real profile, with the same safeguards as 2.5B:
1. The app was closed and both `%USERPROFILE%\.gemini` and `%APPDATA%\Antigravity` were copied to `backups\phase4-20261029-1425` and hashed. Every file matched except the `cli.log` symlink, which needs admin rights or Developer Mode to copy.
2. Every install and uninstall went through `agy`. No config file was edited by hand (see [Cleanup](#cleanup) for the one entry still waiting).
3. The scratch workspace held a copy of [`test/fixtures/claude/`](../test/fixtures/claude/).

**Validate and install.** With `%APPDATA%\Antigravity\bin` on PATH:
- `agy plugin validate --strict` reported `skills 1 · agents 1 · rules 1 · hooks 1 · mcpServers 1 · sidecars 1` and passed with no findings.
- `agy plugin install` printed `[ok]`. `agy plugin list` showed `agy-plugin-porter (enabled, 0.1.0)` with `1 skill, 1 agent, 1 rule, 1 MCP server, 1 hook`. It doesn't count sidecars, but `config/plugins/agy-plugin-porter/sidecars/cockpit/` was copied whole.

## Checks

| Check | Result | Evidence | Label |
| :-- | :-- | :-- | :-- |
| SessionStart detector, once per workspace | **Works.** The first conversation got one `systemMessage` naming "a Claude Code plugin" in the workspace and pointing at the `port-plugin` skill and the cockpit. The agent quoted it word for word when asked. A second conversation in the same workspace got nothing. | Transcripts; `plugin_data/agy-plugin-porter/session-start.json` recorded the workspace once, with hash `20f372d6e8705293` | live |
| Agent: preview, report, consent, install | **Works.** The agent called `port_preview` and showed the whole report: Tier 3, 10 ported, 1 not ported (`UserPromptSubmit`, with the reason), 3 warnings, 0 flags, validate passed. After "No, don't install it" it didn't install. After "Actually, yes, install it" it called `port_install` and reported `Installed fixture-claude`, with the switch-off reminder, in 14 s. | Transcript; `agy plugin list` shows `fixture-claude (enabled, 0.1.0)` | live |
| Cockpit: preview, confirm, install | **Works.** Source `test/fixtures/cursor`, name `cursor-rules`: Tier 1, 6 ported, 0 not ported, 0 warnings, 0 flags, "agy plugin validate passed". **Install…** opened a dialog: "It will be installed into your Antigravity profile as Tier 1 (telemetry), with 0 item(s) not ported and 0 audit flags." Confirming installed it, and the status line said to switch it off before uninstalling. | Screenshots; `cockpit.log` `preview` at 15:25:09 and `install` at 15:31:34 | live |
| The ports show up | **Yes.** **Customizations > Plugins** listed **Plugin Porter**, **cursor-rules** and **fixture-claude**. `agy plugin list`: `cursor-rules` with 2 skills and 3 rules; `fixture-claude` with 2 skills, 1 agent, 1 rule, 2 MCP servers and 1 hook. | Screenshot; `agy plugin list` | live |
| `agy` on PATH for the app's processes | **Yes, for the MCP server and the cockpit.** Both ran `agy plugin validate` (reported as passed) and `agy plugin install`. | The agent's report and the cockpit's; the installs | live |
| `git` on PATH for the cockpit | **Yes.** The cockpit's first GitHub preview cloned the repo (188 files) before failing at cleanup (next row). The MCP server wasn't given a GitHub source. | The clone left in `%TEMP%\agy-porter-src-A8alSJ` | live |
| GitHub source in the cockpit | **Works after a fix.** `anthropics/claude-code@v2.1.98` with path `plugins/commit-commands` first failed after 3.1 s: `EPERM, Permission denied: \\?\C:\…\Temp\agy-porter-src-A8alSJ`. After the fix it previewed commit `c5600e0`: Tier 1, 4 ported, 4 warnings, 0 flags, validate passed, and no clone left in `%TEMP%`. | Screenshot; `cockpit.log` `preview` at 15:48:13 | live |
| GitHub source through the MCP server, and its timeout | **Not tested.** The same port takes 2.6 s under `agy-node` from the command line, so a small pinned repo is far from any timeout. A large repo wasn't tried, and agy's MCP tool timeout isn't known. | CLI run | static |
| Agent ports only when asked | **Works after a fix.** In a third conversation, "What's in this workspace?" got a description of the plugin and an offer to port it, without a `port_preview` call. The app wasn't restarted. It started the new build's MCP server at 15:49:35, so the new plugin was loaded. That the agent followed the new rule text, rather than holding back on its own, is inferred. | Transcript; process start time | live |

## Other findings

| Finding | Evidence | Label |
| :-- | :-- | :-- |
| **Node 24's `rmSync` can't delete read-only files on Windows.** A git clone's pack files are read-only, so every GitHub source failed at cleanup inside the app. A minimal script with one read-only file fails under `agy-node` (v24.21.0) and works under Node v26.3.0. Fixed: `removeTree` in `lib/source.mjs` retries once with every file made writable. The source clone, the staging and output folders and the previews all use it. CI's Windows + Node 24 job now covers it with a unit test. | The `EPERM` above; the minimal script | live |
| **The skill's description made the agent preview unasked.** It said to use the skill "when the workspace holds one". In the second conversation, "What's in this workspace?" was answered with a full port report. Consent still held: nothing was installed without a yes. Fixed: the skill and `rules/AGENTS.md` now say a plugin in the workspace isn't a request. | Transcript | live |
| **A reinstall is picked up live.** `agy plugin uninstall` then `install` wrote the new files at 15:43:34. The app started a new cockpit at 15:43:43 without a restart. | `cockpit.log` `start` (pid 14728, port 53180); process start time | live |
| **Customizations can show a stale state.** The porter was switched off, then uninstalled and reinstalled with `agy`. **Customizations** still showed it off, while `agy plugin list` said `enabled`, the app ran its cockpit and started its MCP server for a new conversation. | Screenshot; `agy plugin list`; processes | live |
| **Switching off left an MCP server running.** After that stale sequence, switching all three plugins off stopped the cockpit, but the porter's MCP server (`cmd.exe /c agy-node …/mcp/server.mjs` and its child) kept running. It was stopped by hand before the uninstall. In 2.5A, switching a plugin off stopped its MCP server at once, so this is probably a consequence of the stale state. | Process list | live |
| **`agy plugin uninstall` keeps the plugin's data.** After the reinstall, the detector's `session-start.json` and the cockpit's data folder were still there, so the detector stayed quiet in the scratch workspace. | `plugin_data/agy-plugin-porter/`, `sidecar_data/agy-plugin-porter/` | live |
| **`agy plugin uninstall` leaves the app's own files.** After uninstalling, these were left: the `sidecars["agy-plugin-porter/cockpit"]` entry in `config.json`, its `config/projects/` file, the MCP tool caches (`antigravity/mcp/agy-plugin-porter_cli`, `fixture-claude_inline-echo`, `fixture-claude_github`), and the `plugin_data` and `sidecar_data` folders. By 2026-11-06 the app had removed the `plugin_data` folder and the project file on its own. | Profile diff against the backup; recheck on 2026-11-06 | live |
| **An install deletes its preview.** Both installed previews were gone from `%TEMP%\agy-plugin-porter\previews\`. The GitHub preview, never installed, stayed until it was deleted by hand. Previews also expire after an hour. | `%TEMP%\agy-plugin-porter\previews\` | live |

## Changes since the run

These landed after the live run. They're covered by the offline tests on Windows, Linux and macOS, but not live-tested:
- **Previews moved out of the temp folder.** They're now kept in `%LOCALAPPDATA%\agy-plugin-porter\previews` on Windows and `~/.cache/agy-plugin-porter/previews` elsewhere (or `$XDG_CACHE_HOME`), created readable only by the user. On a multi-user Linux machine, another user could have made `/tmp/agy-plugin-porter` first and changed a preview between the preview and the install. The detector's state file no longer falls back to the temp folder either.
- **The hook shim runs when its plugin is reached through a symlink.** It used to run only when `process.argv[1]` matched its own URL exactly. Node resolves symlinks in the URL but not in `argv[1]`, so a plugin reached through a link (macOS's `/var`, a linked home or `.gemini`, a Windows junction) exited 0 without running its hook. CI on macOS found it.

## Changes from the plan

- **No progress stream.** The cockpit's `POST /api/preview` waits for the port to finish instead of streaming progress over SSE. It runs one port at a time (a second gets 409) and shows "Porting…" meanwhile. A pinned GitHub source took a few seconds.
- **No `antigravity-sidecar-kit`.** The plugin gets no `npm install`, so the cockpit is zero-dependency and reuses the mod runtime's `lifecycle.mjs`, already proven live inside a plugin sidecar.
- **Only the cockpit's dialog is real consent.** An agent could pass the preview's tier and digest back without asking. The rules and skill tell it to show the report and wait for a yes, and in this run it did.

## Reproduce

1. Close the app and back up both folders (see [ui-mods-baseline.md step 0](./ui-mods-baseline.md#step-0-does-a-plugin-sidecar-run-in-the-desktop-app)).
2. `npm run build:plugin`, then `agy plugin validate dist/plugin/agy-plugin-porter --strict` and `agy plugin install dist/plugin/agy-plugin-porter`, with `%APPDATA%\Antigravity\bin` on PATH.
3. Open a workspace holding a copy of `test/fixtures/claude`:
   - start a conversation and ask whether anything told the agent about the workspace
   - start a second one and ask what's in the workspace; the agent should offer to port, not preview
   - ask it to port the plugin, say no, then yes
4. In the **Plugin Porter** pane:
   - preview `test/fixtures/cursor` with the name `cursor-rules`, then install it through the dialog
   - preview `anthropics/claude-code@v2.1.98` with the path `plugins/commit-commands`
5. Read `~/.gemini/antigravity/sidecar_data/agy-plugin-porter/cockpit/data/cockpit.log`.
6. To uninstall, switch each plugin off in **Customizations > Plugins** first. Check that no `…/agy-plugin-porter/mcp/server.mjs` process is left, then run `agy plugin uninstall <name>`.

## Cleanup

The three plugins were switched off. The porter's leftover MCP server was stopped, with the researcher's approval, and all three were uninstalled with `agy plugin uninstall` (clean). Both folders were hashed again and compared with the backup's manifest.

**Removed by hand:** the MCP tool caches and the porter's `sidecar_data` folder (its `cockpit.log` was copied to the backup first). The app had already removed the `plugin_data` folder and the cockpit's project file.

**Left behind, as of 2026-11-06:** the `sidecars["agy-plugin-porter/cockpit"]` entry in `config.json` (`projectId` and `schemaVersion` only). It points at nothing, and it'll be removed the next time the app is closed.

**Expected churn from using the app:**
- the test conversations (`brain/`, `conversations/`, `annotations/`, `presence/`) and the `phase4-ws` project
- the other sidecars' event logs, conversation summaries and app state
- Chromium caches, Local and Session Storage, and the app logs under `%APPDATA%\Antigravity`

**Not from the test plugins:** changes to Hangar's layout, the scope of `docker-ops` and the Android CLI sidecars in `hangar.json`, `docker-ops` switched off in `config.json`, and a project for another workspace. None of them involves the porter or its ports. They're Hangar and app settings changed during the session, and were left as they are.
