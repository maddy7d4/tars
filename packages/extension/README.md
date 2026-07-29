# TARS

AI engineering agent for VS Code, Cursor and VSCodium, built on the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Authentication

TARS builds no login flow. The Agent SDK resolves credentials through the standard
Anthropic precedence chain — `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then
the OAuth profile on disk from an existing `claude` login. If you already use
Claude Code, TARS needs no configuration.

An API key is never read from or written to `settings.json`.

## Settings

| Setting                 | Values                          | Default | Meaning                                             |
| ----------------------- | ------------------------------- | ------- | --------------------------------------------------- |
| `tars.permissionPolicy` | `always_allow` · `ask` · `deny` | `ask`   | Default decision for tool invocations needing review |

## Commands

- **TARS: Open Chat** (`tars.openChat`) — reveals the chat view.

## Status

Phase 0 of the plan in `Docs/TARS_SPEC.md`: the workspace, build, packaging and
CI foundation, plus the activity-bar view and its strict-CSP webview shell. The
agent session lifecycle lands in phase 1.
