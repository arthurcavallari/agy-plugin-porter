# agy-plugin-porter

<p>
  <a href="https://www.npmjs.com/package/agy-plugin-porter"><img src="https://img.shields.io/npm/v/agy-plugin-porter?logo=npm&color=cb3837" alt="npm version" height="20"></a>
  <a href="https://github.com/arthurcavallari/agy-plugin-porter/actions/workflows/test.yml"><img src="https://github.com/arthurcavallari/agy-plugin-porter/actions/workflows/test.yml/badge.svg" alt="Tests" height="20"></a>
  <img src="https://img.shields.io/node/v/agy-plugin-porter?logo=nodedotjs&logoColor=white&color=339933" alt="Node.js version" height="20">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" height="20"></a>
  <a href="https://github.com/sponsors/arthurcavallari"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub" height="20"></a>
</p>

> Ports Claude Code, Gemini CLI, Cursor, Roo/Kilo and Codex plugins to native **Google Antigravity** plugins, and tells you exactly what did and didn't carry over.

`agy plugin install` already stages Claude Code and Gemini CLI plugins, but much of what it stages never runs. Hooks keep their foreign shape, `${CLAUDE_PLUGIN_ROOT}` stays unexpanded, and Claude agents are skipped by the loader. `CLAUDE.md` is never loaded either. agy still reports success. Cursor, Roo/Kilo and Codex sources aren't detected at all.

`agy-plugin-porter` fills those gaps and audits the result. It's zero-dependency (`esbuild` is optional, for TS/TSX UI mods), pure Node.js (`>= 20.0.0`) ESM, and it's the porting engine behind [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar)'s plugin installs (Hangar 1.2.0 and later).

**Status: 0.x.** Phases 0–2 of [`docs/plan.md`](docs/plan.md) are done, plus Phase 2.5 (Claude Code UI mods, [`docs/phase-2.5-ui-mods-plan.md`](docs/phase-2.5-ui-mods-plan.md)) and Phase 4 ([the porter inside Antigravity](#the-porter-inside-antigravity)). What agy itself handles was measured against agy 1.4.5 and is recorded in [`docs/agy-baseline.md`](docs/agy-baseline.md).

---

## Quick start

```bash
npx agy-plugin-porter --source ./my-claude-plugin --out ./ported --validate
agy plugin install ./ported
```

`--source` also takes a GitHub repo pinned to a tag, branch or commit: `owner/repo@<ref>`, plus `--path <subfolder>` for monorepos. When the subfolder has no license file, the port gets the one at the repository root. `--install` runs `agy plugin install` on the output for you. Restart Antigravity afterwards so it discovers the new plugin directory.

```
agy-porter --source <path|owner/repo@ref> [--path <dir>] [--slug <name>] [--out <dir>]
           [--force] [--validate] [--install] [--agy <path>] [--json]
```

Every run prints a **port report**:
- what was ported
- what wasn't, with the reason
- warnings
- static-audit flags
- an inferred capability tier, using the same `TIER_1_TELEMETRY` / `TIER_2_LOCAL_TOOLING` / `TIER_3_AGENT_CONTROL` meaning as Hangar

Nothing is dropped silently.

## Requirements

- Node.js 20 or newer.
- `agy` on `PATH` for Claude Code and Gemini CLI sources. The porter stages them with `agy plugin install`, always against a **throwaway home** (`HOME`/`USERPROFILE` set to a temp dir), so your real Antigravity profile is never read or written. Cursor, Roo/Kilo and Codex sources don't need agy. `--validate` runs `agy plugin validate`, also in a throwaway home.

## What gets ported

| Source | Becomes |
| :-- | :-- |
| Claude `hooks/hooks.json`, Gemini hooks | Native named-hook `hooks.json`. Events and tool matchers are remapped (`Bash` → `run_command`, `Edit\|Write` → …), and every handler runs through `scripts/hook-shim.mjs`. |
| Claude/Gemini commands | Skills with a proper `name`. Claude-only frontmatter is stripped, and argument placeholders are rewritten. |
| `.mcp.json`, inline `mcpServers`, extension MCP | `mcp_config.json`, with `${CLAUDE_PLUGIN_ROOT}` / `${extensionPath}` → `${PLUGIN_ROOT}` |
| Claude `agents/*.md` | agy agents, with agy tool names and model tiers |
| Roo/Kilo `.roomodes` | agy agents. Tool groups are mapped, and mode rules are folded into the body. |
| `CLAUDE.md`, `GEMINI.md`, Codex `AGENTS.md` | `rules/AGENTS.md` |
| Cursor `.mdc` | Always-on rules, `model_decision` rules, or skills (glob-scoped and manual rules) |
| `.cursorrules`, Roo/Cline/Kilo rules | Always-on rules |
| Codex `.agents/skills` | Skills |
| Claude Code UI mods (`hooks.json` with `modules`) | A plugin sidecar per mod, with its pane in Antigravity's side panel. See [UI mods](#ui-mods). |

A port holds no symlinks or junctions. A link to a file or folder inside the source becomes a copy of it. A link to anything outside the source, a link to nothing, and a link to a folder it sits in are left out and reported unported.

### The hook shim

agy's hook contract differs from Claude Code's and Gemini CLI's: camelCase payloads, a JSON decision on stdout, and fail-closed on any nonzero exit. The shim ships inside each ported plugin and bridges the two:
- **Payload:** translates it to the source's snake_case shape, with the source's tool names and argument names.
- **Plugin paths:** expands `${CLAUDE_PLUGIN_ROOT}` and friends.
- **Results:**
  - exit 2 → `{"decision":"deny","reason":<stderr>}`
  - plain SessionStart text → injected context
  - other failures → allow plus a warning, matching the source's non-blocking semantics

The original commands live in `scripts/hook-shim.json`, so they never pass through agy's command line, which mangles quoted paths on Windows.

### UI mods

A Claude Code UI mod is a JS/TS module whose `register(on)` draws panes and hooks into the agent loop. The porter compiles each one into a plugin sidecar:
- **Pane:** the mod's `Pane` renders in a view in Antigravity's side panel. Open it from the `sidecar://` link a command's reply carries, or from its tab.
- **Events:** `session.start`, `turn.start`, `turn.complete` and `tool.call` run from agy hooks forwarded to the sidecar. A `tool.call` handler can observe and deny built-in tool calls (live-tested). It can also rewrite their input, which is implemented but not yet live-tested.
- **Commands and tools:** each `$.command.register` becomes a skill plus a button in the view's toolbar. Each `$.tool.register` becomes an MCP tool.
- **Report:** a mod is ported clean, partially (each fallback listed), or refused (for example, a mod that only draws into the transcript). A static scan lists every `$` call, and the runtime exposes only those.

What maps fully, partially and not at all, tested live against three real mods, is in [`docs/ui-mods-baseline.md`](docs/ui-mods-baseline.md).

TS/TSX mods need [`esbuild`](https://esbuild.github.io/), an optional dependency installed with the porter. Without it, those mods are reported unported. Plain JS mods need nothing. A ported mod is a full Node process outside agy's permission prompts, so it's always at least Tier 2.

**Uninstalling:** switch the plugin off in **Customizations > Plugins** before `agy plugin uninstall`. On Windows a running sidecar holds its folder open, and the uninstall fails halfway.

### Static audit

Before writing the output, the porter:
- strips Unicode tag characters (U+E0000–E007F)
- flags `curl | sh`-style pipes, decode-and-execute patterns, encoded PowerShell, bidi controls and high-entropy strings
- checks agy's 24 KB per-rule and 20k-token always-on rules budgets

## The porter inside Antigravity

The porter also ships as an Antigravity plugin, so you can port from inside the app. GitHub releases after 0.1.0 carry it as `agy-plugin-porter-plugin-<version>.tgz`, with a `.sha256` beside it. Unpack it and install the folder:

```bash
tar -xzf agy-plugin-porter-plugin-<version>.tgz
agy plugin install ./agy-plugin-porter
```

To build it from a checkout instead, run `npm run build:plugin` and install `dist/plugin/agy-plugin-porter`.

The plugin adds:
- **A detector.** When a conversation starts in a workspace that holds a Claude Code, Gemini CLI, Cursor, Roo/Kilo or Codex plugin, the agent is told once per workspace. It mentions the plugin and doesn't port anything unasked.
- **A skill, an agent and rules** for porting with the porter, never by hand.
- **Two MCP tools**, `port_preview` and `port_install` (server `agy-plugin-porter_cli`).
- **The Plugin Porter pane.** Enter a folder or `owner/repo@<tag>`, read the full port report, then install.

**Consent.** Every install starts with a preview, which ports into a temp folder and shows the report. An install takes only that preview's output, and only when it gets back the preview's tier and audit-findings digest. That's the same rule Hangar's installer uses. The pane asks you in a confirm dialog. The agent is told to show you the report and wait for your yes, but only the pane's dialog is enforced. Previews are kept in a folder only you can access (`%LOCALAPPDATA%\agy-plugin-porter\previews` on Windows, `~/.cache/agy-plugin-porter/previews` elsewhere), never in the shared temp folder, and expire after an hour.

**Limits:**
- There's no `esbuild` inside the plugin, so TS/TSX UI mods are reported unported. Port those with `npx agy-plugin-porter`.
- Claude Code and Gemini CLI sources need `agy` on the app's PATH, and GitHub sources need `git`. Both were there in the live run.

**Uninstalling:** switch it off in **Customizations > Plugins** first, then run `agy plugin uninstall agy-plugin-porter`.

What was tested live, and what the app leaves behind after an uninstall, is in [`docs/plugin-baseline.md`](docs/plugin-baseline.md).

## Library

```js
import { portPackage } from 'agy-plugin-porter';

const { report, tier } = await portPackage({
  source: 'owner/repo@v1.2.3', // or srcDir: '/path/to/plugin'
  outDir: '/tmp/ported',
  slug: 'my-plugin',
  validate: true,
});
```

Subpath exports cover the individual stages: `./detector`, `./hook-compiler`, `./manifest-sanitizer`, `./mod-compiler`, `./skill-compiler`, `./rules-compiler`, `./mode-compiler`, `./static-auditor` and `./transpiler-engine`.

## Development

```bash
npm test           # unit + end-to-end tests over test/fixtures/
npm run test:pack  # packs the tarball, installs it in an empty project, and runs it
```

The tests that need agy (Claude/Gemini staging and `agy plugin validate`) skip when `agy` isn't on `PATH`, as on the CI runners. Run `npm test` locally with agy installed to cover them. Releases publish from a `v*` tag through npm trusted publishing (`.github/workflows/publish.yml`).

## Support

Built and maintained in my spare time (with constant keyboard supervision from my three cats, **Snow** 🤍, **Eevee** 🦊, and **Merlin** 🧙‍♂️).

If **agy-plugin-porter** saves you time porting and auditing plugins for Antigravity, consider [❤️ sponsoring me on GitHub Sponsors](https://github.com/sponsors/arthurcavallari) to help fund ongoing maintenance, new transpiler support, and the household Churu treat budget!

## License

[MIT](LICENSE)
