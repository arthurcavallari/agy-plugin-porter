# Phase 2.5A spike

Three Claude Code UI mods, hand-ported into Antigravity plugins with a side-pane sidecar. The results are in [docs/ui-mods-baseline.md](../docs/ui-mods-baseline.md#phase-25a-spike), and the plan is [docs/phase-2.5-ui-mods-plan.md](../docs/phase-2.5-ui-mods-plan.md) §4.

This is throwaway spike code. It isn't part of the npm package, and 2.5B replaces it with `lib/mod-compiler.mjs` and `scripts/mod-runtime/`.

## Layout

| Path | What it is |
| :-- | :-- |
| `mods/<mod>/src/` | The upstream mod source, unchanged, at the commit in `port.json` (MIT, see each `LICENSE`) |
| `mods/<mod>/port.json` | What a static scan would find: commands, tool hooks, the MCP server name |
| `runtime/` | The hand-written runtime that each plugin's sidecar carries (`server.mjs`, `engine.mjs`, `ui.html`, ...) |
| `jsx.mjs` | The hand-written JSX pass for the `--transform node` option |
| `build.mjs` | Assembles `out/<plugin>/` from a mod and the runtime |
| `smoke.mjs` | Drives each built sidecar offline, the way agy would |

## Build and test

The default transform needs `esbuild`. Pass its package folder if it isn't installed next to the porter.

```bash
node spike/build.mjs --esbuild <path>/node_modules/esbuild
node spike/build.mjs --transform node
node spike/smoke.mjs
```

The smoke test writes each mod's final pane trees to `out/smoke-<plugin>.<transform>.json`, so you can compare the two transforms.

## Install

```bash
agy plugin validate --strict --json spike/out/porter-spike-task-board
agy plugin install spike/out/porter-spike-task-board
```

Restart the app, then type `/task-board`, `/replay` or `/side-pane` in a conversation. Each command returns a `sidecar://` link that opens the pane.
