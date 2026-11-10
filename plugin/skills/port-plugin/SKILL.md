---
name: port-plugin
description: Ports a Claude Code, Gemini CLI, Cursor, Roo/Kilo or Codex plugin into a native Antigravity plugin, shows the port report, and installs it once the user agrees. Use when the user asks to port, convert, import or install a plugin from another tool. A plugin in the workspace is not a request: mention it and wait.
---

# Port a plugin into Antigravity

1. **Find the source.** A folder path (the workspace, or a subfolder of it), a GitHub repo as `owner/repo@<tag or commit>`, or a github.com link the user gives you. For a monorepo, also find the subfolder that holds the plugin (`path`). A link to a folder (`.../tree/<ref>/<folder>`) already names it, so pass the link as `source` and leave `path` out.
2. **Preview.** Call `port_preview` (server `agy-plugin-porter_cli`) with `source`, and `path` and `slug` if needed. It can take a minute for a GitHub source.
3. **Show the report.** Tell the user, in full:
   - the capability tier and why
   - what was ported
   - what wasn't, with each reason
   - the warnings and the audit flags
   - whether `agy plugin validate` passed
4. **Ask.** Ask the user whether to install it. Stop there until they answer.
5. **Install on a yes.** Call `port_install` with `previewId`, `acceptedTier` (the preview's `tier`) and `acceptedFlags` (the preview's `flagsDigest`). If it refuses, say why, and preview again if needed.
6. **Finish.** Tell the user the plugin's name, and that they can switch it off in **Customizations > Plugins**.

The user can do the same in the **Plugin Porter** cockpit pane, which asks for consent itself.
