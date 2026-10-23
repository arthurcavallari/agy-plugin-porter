---
name: porter-step0-hello
description: Opens the porter step 0 hello pane, a test side pane with a counter. Use when the user asks to open, show or test the hello pane, or asks for its pill.
---

# Hello pane (porter step 0)

This plugin is a test fixture for agy-plugin-porter. It has one sidecar, `porter-step0-hello/hello`, whose side-pane view shows a counter, a button and the last `run_command` hook event.

## Open the pane

When the user asks to open or show the hello pane, reply with both pills below, exactly as written, each on its own line:

[Open hello pane](sidecar://porter-step0-hello/hello/ui.html)

[Open hello pane (conv)](sidecar://porter-step0-hello/hello/ui.html?conv=porter-step0-conv-marker)

The second pill tests whether a query string survives the trip to the view. Don't change the `conv` value.

## Tools

- `hello_status` returns the sidecar's `server_info.json` (token redacted) and its counter.
- `hello_bump` adds one to the counter.

Both work only while the sidecar runs. If a tool says the sidecar isn't running, report that as is.
