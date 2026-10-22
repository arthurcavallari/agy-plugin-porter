# agy-plugin-porter

> Ports Claude Code, Gemini CLI, Cursor, Roo/Kilo and Codex plugins to native **Google Antigravity** plugins, and tells you exactly what did and didn't carry over.

`agy plugin install` already stages Claude Code and Gemini CLI plugins, but much of what it stages never runs. Hooks keep their foreign shape, `${CLAUDE_PLUGIN_ROOT}` stays unexpanded, and Claude agents are skipped by the loader. `CLAUDE.md` is never loaded either. agy still reports success. Cursor, Roo/Kilo and Codex sources aren't detected at all.

`agy-plugin-porter` fills those gaps and audits the result. It's zero-dependency, pure Node.js (`>= 20.0.0`) ESM, and it's built to be the porting engine for [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar)'s plugin installs. That integration is planned and not built yet.

**Status: 0.x.** Phases 0–2 of [`docs/plan.md`](docs/plan.md) are done. What agy itself handles was measured against agy 1.4.5 and is recorded in [`docs/agy-baseline.md`](docs/agy-baseline.md).

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
| Claude Code UI mods (`hooks.json` with `modules`) | Detected and reported as unported. Nothing is copied or run. |

### The hook shim

agy's hook contract differs from Claude Code's and Gemini CLI's: camelCase payloads, a JSON decision on stdout, and fail-closed on any nonzero exit. The shim ships inside each ported plugin and bridges the two:
- **Payload:** translates it to the source's snake_case shape, with the source's tool names and argument names.
- **Plugin paths:** expands `${CLAUDE_PLUGIN_ROOT}` and friends.
- **Results:**
  - exit 2 → `{"decision":"deny","reason":<stderr>}`
  - plain SessionStart text → injected context
  - other failures → allow plus a warning, matching the source's non-blocking semantics

The original commands live in `scripts/hook-shim.json`, so they never pass through agy's command line, which mangles quoted paths on Windows.

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

Subpath exports cover the individual stages: `./detector`, `./hook-compiler`, `./manifest-sanitizer`, `./skill-compiler`, `./rules-compiler`, `./mode-compiler`, `./static-auditor` and `./transpiler-engine`.

## Development

```bash
npm test           # unit + end-to-end tests over test/fixtures/
npm run test:pack  # packs the tarball, installs it in an empty project, and runs it
```

The tests that need agy (Claude/Gemini staging and `agy plugin validate`) skip when `agy` isn't on `PATH`, as on the CI runners. Run `npm test` locally with agy installed to cover them. Releases publish from a `v*` tag through npm trusted publishing (`.github/workflows/publish.yml`).

## License

[MIT](LICENSE)
