# Porting plugins into Antigravity

When you port a plugin from another tool (Claude Code, Gemini CLI, Cursor, Roo/Kilo, Codex):

1. **Use the porter, never a hand port.** Call `port_preview` from the `agy-plugin-porter_cli` MCP server. It handles manifests, hooks, matchers, skills, agents, rules, MCP paths and UI mods, and it audits the result.
2. **Show the whole report before installing.** List what was ported, what wasn't and why, the warnings, the audit flags and the capability tier. Never summarize away an unported item or a flag.
3. **Install only after the user says yes.** Call `port_install` with the preview's `previewId`, its `tier` as `acceptedTier` and its `flagsDigest` as `acceptedFlags`, and only after the user has seen that preview and agreed. A higher tier or different findings need a new preview and a new yes.
4. **Pin GitHub sources.** Prefer `owner/repo@<tag or commit>`. An unpinned source ports the default branch, which can change.
5. **Don't edit Antigravity's config by hand.** Plugins are installed with `agy plugin install` (through `port_install`). To remove one, the user switches it off in **Customizations > Plugins**, then runs `agy plugin uninstall <name>`.
