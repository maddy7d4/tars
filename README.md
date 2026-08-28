# TARS

An AI engineering platform delivered as a VS Code extension. TARS runs in **VS Code, Cursor, VSCodium**, and compatible forks, and installs as an ordinary `.vsix` without modifying the editor.

> **Status:** in active development. Phases 0–1 are complete; see [ROADMAP.md](ROADMAP.md) for what ships when.

---

## What it is

TARS wraps the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) — Claude Code packaged as a library — in an editor-native surface: streaming chat, a tool-call timeline, reviewable diffs, checkpoints, and workspace memory.

It is built on **documented, stable VS Code extension APIs only**. No private Cursor APIs, no editor patching, no reverse engineering.

## Why not just use the Chat Participant API?

Because it would not run where TARS needs to run. `vscode.lm` and the Chat Participant API are Copilot-gated and unreliable across forks, so TARS uses a custom webview and reaches the model through the Agent SDK instead. That single constraint shapes most of the architecture — see [ADR 0002](Docs/adr/0002-custom-webview-not-vscode-lm.md).

## Authentication

**If you already use Claude Code, there is nothing to configure.** The Agent SDK resolves credentials in the standard order:

```
ANTHROPIC_API_KEY  →  ANTHROPIC_AUTH_TOKEN  →  OAuth profile from `claude` login
```

TARS builds no login flow of its own. Teams that need to inject an explicit key can store one in the OS keychain via the extension's secret storage. An API key is **never** read from or written to `settings.json`.

---

## Architecture in one screen

```
packages/
  shared/       Types + IPC contracts. Zero runtime dependencies.
  core/         Pure TypeScript. Never imports `vscode` (CI-enforced).
                Agent orchestration · provider registry · diff engine
                context engine · memory · checkpoints · planner
  host/         The only package that imports `vscode`.
                Implements core's ports; owns commands, views, status bar.
  webview-ui/   React 19 + Vite + Tailwind v4.
  extension/    Activation entry. Composition root.
```

Dependencies flow one way, and the build enforces it:

```
extension → host → core → shared
webview-ui → shared
```

Two rules carry most of the design:

1. **`core` never imports `vscode`.** An ESLint rule fails CI if it does. That is why the agent loop, diff engine, and checkpoint logic are unit-testable in plain Node with no editor harness — and why the test suite runs in well under a second.
2. **Only `provider/claude-code/` imports the Agent SDK.** Every provider maps its native stream onto one normalized `AgentEvent` union, so an SDK breaking change is contained to a single adapter rather than rippling through the UI. The SDK is pre-1.0; this seam is insurance, not ceremony.

Full detail: [Docs/TARS_SPEC.md](Docs/TARS_SPEC.md). Decisions and their alternatives: [Docs/adr/](Docs/adr/).

---

## Development

Requires **Node 24+**. pnpm comes from corepack — do not install it globally.

```bash
corepack enable pnpm
pnpm install
pnpm verify        # typecheck → lint → test → build
```

| Command | Does |
|---|---|
| `pnpm verify` | The full gate. Run this before every commit. |
| `pnpm typecheck` | `tsc -b` across all packages |
| `pnpm lint` | ESLint, including the core/`vscode` boundary rule |
| `pnpm test` | Vitest across all packages |
| `pnpm build` | esbuild (extension/host) + Vite (webview) |
| `pnpm package` | Produces `packages/extension/tars-1.0.0.vsix` |

**Run the extension:** open the repo in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host.

**Install the built `.vsix`:**

```bash
pnpm package
code --install-extension packages/extension/tars-1.0.0.vsix
# Cursor: cursor --install-extension …   VSCodium: codium --install-extension …
```

### Testing

Coverage concentrates in `core` precisely because the dependency rule made it cheap to test there — `host` stays deliberately thin so little logic requires the slow editor harness.

| Layer | Tool |
|---|---|
| `core` | Vitest, plain Node |
| `webview-ui` | Vitest + React Testing Library |
| `host` | `@vscode/test-electron` |

`pnpm test` runs the fast suites. **Vitest does not typecheck**, so a green test
run alone is not a green build: `pnpm verify` chains typecheck, lint, test,
build, size budgets and the integration suite for exactly that reason.

The integration tests load the real bundle in a real editor and run after the
build (`pnpm test:integration`, `xvfb-run` on Linux). They exist for the failures
a fake cannot reach — the first run found that the extension could not activate
at all, while all 545 unit tests passed.

---

## Safety model

Tool invocations pass through a permission gate before they run ([spec §4.2](Docs/TARS_SPEC.md)). Destructive and outward-facing tools — `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, and every `mcp__*` tool — default to **ask**.

A session-wide `always_allow` does **not** unlock them; only an explicit per-tool override can, and that override is a deliberate instruction naming the specific tool. If no approval UI is attached, the gate **fails closed** and denies. These invariants are asserted directly in the test suite rather than left to inspection.

The prompt offers **Allow once** and **Always allow** as separate buttons, because
the two differ in blast radius. A promotion lasts the session and never beyond it.

### Review is after the fact, and that is deliberate

TARS uses the Agent SDK's own `Write` and `Edit` tools, and those write to the
workspace themselves. `canUseTool` can hold a tool before it runs or refuse it,
but it cannot take the write and defer it — so there is no honest way to present
edits as "pending approval". They are already on disk.

Safety therefore rests on two things that are real rather than one that is not:
the permission gate runs **before** the write, and a checkpoint is taken **before**
the write, from the event the SDK emits ahead of execution. The checkpoint is
re-persisted after each file, so a crash mid-turn still leaves a way back.

You then review in the editor, where the change is: changed regions are coloured
with **Accept** and **Reject** on each hunk, and the chat panel offers **Keep** or
**Revert** for the whole turn. Rejections and reverts apply as a single
`vscode.WorkspaceEdit`, so they land in the editor's own undo stack —
<kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes a mistaken rejection exactly as it undoes a
human edit.

The full reasoning, including the alternatives rejected, is
[ADR 0009](Docs/adr/0009-post-hoc-review.md).

## Context

Type `@` in the prompt for completions drawn from three sources: the workspace
file index, workspace symbols from **your own language servers** (TARS ships no
parsers), and editor state.

| Mention | Attaches |
|---|---|
| `@path/to/file.ts` | A file. A bare basename works when unambiguous; an ambiguous one resolves to nothing rather than guessing. |
| `@selection` | The code you have selected. |
| `@problems` | Diagnostics from your language servers. |
| `@diff` | The working tree, from the built-in git extension. |
| `@branch` | The current branch. |

A mention that resolves is carried structurally and removed from the prose; one
that does not is left in place and reported, so a mention that attached nothing is
never silent.

## Commands

| Command | What it does |
|---|---|
| `TARS: Open Chat` | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> |
| `TARS: New Session` | Fresh conversation |
| `TARS: Stop` | Interrupt the running turn |
| `TARS: Resume a Conversation` | Reopen a past conversation from its log |
| `TARS: Restore a Checkpoint` | Return the workspace to an earlier point |
| `TARS: Show Workspace Memory` | What TARS has learned about this project |
| `TARS: Clear Workspace Memory` | Forget it |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `tars.permissionPolicy` | `ask` | Session-wide default for gated tools |
| `tars.toolPermissions` | `{}` | Per-tool overrides, e.g. `{"Bash": "deny"}` |
| `tars.review.openEditedFiles` | `true` | Bring an edited file forward so its changes are visible |
| `tars.mcpServers` | `{}` | MCP servers, keyed by name |

## Documentation

| Document | What it covers |
|---|---|
| [`Docs/TARS_SPEC.md`](Docs/TARS_SPEC.md) | Architecture, in full |
| [`Docs/SECURITY.md`](Docs/SECURITY.md) | Threat model, permission gating, what is and is not mitigated |
| [`Docs/PERFORMANCE.md`](Docs/PERFORMANCE.md) | Measured budgets and the bounds on every store |
| [`Docs/adr/`](Docs/adr/) | Why each decision was made, including the ones reversed |

## Compatibility

`engines.vscode` is pinned to `^1.90.0`. Forks track upstream at a lag, so the baseline sits below the oldest supported fork rather than at the newest upstream release. Newer APIs are feature-detected with a fallback; no proposed APIs are used.

## Licence

[MIT](LICENSE). Copyright (c) 2026 Madhavan Parthasarathy.
