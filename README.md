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
| `pnpm package` | Produces `packages/extension/tars-0.0.0.vsix` |

**Run the extension:** open the repo in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host.

**Install the built `.vsix`:**

```bash
pnpm package
code --install-extension packages/extension/tars-0.0.0.vsix
# Cursor: cursor --install-extension …   VSCodium: codium --install-extension …
```

### Testing

Coverage concentrates in `core` precisely because the dependency rule made it cheap to test there — `host` stays deliberately thin so little logic requires the slow editor harness.

| Layer | Tool |
|---|---|
| `core` | Vitest, plain Node |
| `webview-ui` | Vitest + React Testing Library |
| `host` | `@vscode/test-electron` |

`pnpm test` runs green tests — but note that **Vitest does not typecheck**. `pnpm verify` chains typecheck, lint, test and build for exactly that reason; a green test run alone is not a green build.

---

## Safety model

Tool invocations pass through a permission gate before they run ([spec §4.2](Docs/TARS_SPEC.md)). Destructive and outward-facing tools — `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, and every `mcp__*` tool — default to **ask**.

A session-wide `always_allow` does **not** unlock them; only an explicit per-tool override can, and that override is a deliberate instruction naming the specific tool. If no approval UI is attached, the gate **fails closed** and denies. These invariants are asserted directly in the test suite rather than left to inspection.

File edits apply as a single `vscode.WorkspaceEdit`, so they land in the editor's own undo stack — <kbd>Ctrl</kbd>+<kbd>Z</kbd> reverses an AI edit exactly as it reverses a human one.

## Compatibility

`engines.vscode` is pinned to `^1.90.0`. Forks track upstream at a lag, so the baseline sits below the oldest supported fork rather than at the newest upstream release. Newer APIs are feature-detected with a fallback; no proposed APIs are used.

## Licence

No licence has been selected yet. Until one is added at the repository root, the
default position under copyright law is that no permissions are granted — pick a
licence before publishing or accepting outside contributions.
