# agy-plugin-porter

> Ports Claude Code, Gemini CLI, Cursor, Roo/Kilo and Codex plugins to native **Google Antigravity** plugins, and tells you exactly what did and didn't carry over.

`agy plugin install` already stages Claude Code and Gemini CLI plugins, but much of what it stages never runs. Hooks keep their foreign shape, `${CLAUDE_PLUGIN_ROOT}` stays unexpanded, and Claude agents are skipped by the loader. `CLAUDE.md` is never loaded either. agy still reports success. Cursor, Roo/Kilo and Codex sources aren't detected at all.

`agy-plugin-porter` fills those gaps and audits the result. It's zero-dependency (`esbuild` is optional, for TS/TSX UI mods), pure Node.js (`>= 20.0.0`) ESM, and it's built to be the porting engine for [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar)'s plugin installs. That integration is planned and not built yet.

**Status: 0.x.** Phases 0–2 of [`docs/plan.md`](docs/plan.md) are done, plus Phase 2.5 (Claude Code UI mods, [`docs/phase-2.5-ui-mods-plan.md`](docs/phase-2.5-ui-mods-plan.md)). What agy itself handles was measured against agy 1.4.5 and is recorded in [`docs/agy-baseline.md`](docs/agy-baseline.md).

---

## Quick start

```bash
npx agy-plugin-porter --source ./my-claude-plugin --out ./ported --validate
agy plugin install ./ported
```

`--source` also takes a GitHub repo pinned to a tag, branch or commit: `owner/repo@<ref>`, plus `--path <subfolder>` for monorepos. `--install` runs `agy plugin install` on the output for you. Restart Antigravity afterwards so it discovers the new plugin directory.

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

## License

[MIT](LICENSE)
