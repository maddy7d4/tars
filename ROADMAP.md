# TARS — Delivery Roadmap

**Status:** Phases 0–6 delivered
**Date:** 2026-07-30
**Scope:** TARS v1.0, phases 0–6
**Source of truth:** [Docs/TARS_SPEC.md](Docs/TARS_SPEC.md) §2

---

## How this roadmap is used

The full brief spans roughly twenty-five components. That is a programme of work, not one implementation task, so it decomposes into independently shippable phases.

**Each phase gets its own design → plan → implement cycle.** A phase is designed against this roadmap and [TARS_SPEC.md](Docs/TARS_SPEC.md), planned into concrete work, then implemented. No phase begins implementation before its own design and plan exist.

**The repository must never be left broken between phases.** Every phase ends with the repository building, linting, typechecking, and testing green — this is the baseline exit criterion for all seven phases, restated in each section below alongside the criteria specific to that phase. A phase that leaves any of the four red is not done, regardless of feature completeness. Existing functionality is never broken to land new functionality.

**[Phase 2](#phase-2--chat-shell) is the first installable `.vsix` milestone**: a package that installs in Cursor and holds a working streaming conversation over the user's codebase. Every later phase is additive, not architectural.

### Phase dependencies

| Phase | Goal | Depends on |
|---|---|---|
| [0 — Foundation](#phase-0--foundation) | Stand up the monorepo, toolchain, and enforced boundaries so every later phase builds on a green, mechanically policed baseline. | — |
| [1 — Agent Core](#phase-1--agent-core) | Make Claude work headlessly behind TARS's own provider seam, with sessions durably logged. | 0 |
| [2 — Chat Shell](#phase-2--chat-shell) | Ship the first installable `.vsix` that holds a streaming conversation over the user's codebase. | 0, 1 |
| [3 — Edit & Review](#phase-3--edit--review) | Let the agent propose edits that the user reviews, applies atomically, and can restore from. | 1, 2 |
| [4 — Context Engine](#phase-4--context-engine) | Let the user steer what enters context, precisely and quickly. | 1, 2 |
| [5 — Integrations](#phase-5--integrations) | Connect TARS to the surrounding developer environment — terminal, Git, MCP, memory, history. | 1, 2 |
| [6 — Hardening](#phase-6--hardening) | Make v1.0 marketplace-ready: tested, budgeted, security-reviewed, documented. | all |

### Delivery record

All seven phases are delivered. What each turned out to require, where it
differed from the plan:

| Phase | Commit | Note |
|---|---|---|
| 0 — Foundation | `7b3e953` | — |
| 1 — Agent Core | `9aeb92a` | — |
| 2 — Chat Shell | `0fede74` | Permission prompt's single "Allow" was sending a session-wide promotion the host silently downgraded; split into "Allow once" and "Always allow", and the promotion made real. |
| 3 — Edit & Review | `fc70725`, `dc18f10` | **Plan revised.** Propose-then-apply is impossible: the SDK's own file tools write to disk, so there is nothing to hold. Review became post-hoc, backed by checkpoints taken before each write, with per-hunk Accept/Reject in the editor. See [ADR 0009](Docs/adr/0009-post-hoc-review.md). |
| 4 — Context Engine | `c3a40b9` | — |
| 5 — Integrations | `eeb1e1b` | **Scope corrected.** Terminal output is not readable at the `^1.90.0` baseline; the API that can read it landed later, and raising the floor would break the fork compatibility §8.4 protects. Git context (`@diff`, `@branch`) shipped in its place. |
| 6 — Hardening | `c1128f0`, `2186ce6` | The integration suite found a release-blocking activation bug on its first run — `import.meta.url` was `undefined` in the CommonJS bundle, so the extension could not start at all while every unit test passed. |

### Architecture decision records

The decisions this roadmap implements are recorded under [Docs/adr/](Docs/adr/):

| ADR | Decision | Primarily lands in |
|---|---|---|
| [0001](Docs/adr/0001-claude-agent-sdk-as-integration-layer.md) | Claude Agent SDK as the integration layer | Phase 1 |
| [0002](Docs/adr/0002-custom-webview-not-vscode-lm.md) | Custom webview instead of `vscode.lm` / Chat Participant API | Phase 2 |
| [0003](Docs/adr/0003-core-host-webview-split.md) | Core/host/webview split with a CI-enforced dependency rule | Phase 0 |
| [0004](Docs/adr/0004-normalized-agent-event-union.md) | Normalized `AgentEvent` union at the provider seam | Phase 1 |
| [0005](Docs/adr/0005-react-vite-tailwind-webview.md) | React 19 + Vite + Tailwind v4 for the webview | Phase 2 |
| [0006](Docs/adr/0006-append-only-session-event-log.md) | Append-only session event log as the persistence primitive | Phase 1 |
| [0007](Docs/adr/0007-native-diff-editor-and-workspaceedit.md) | Native VS Code diff editor and `WorkspaceEdit` | Phase 3 |
| [0008](Docs/adr/0008-no-embedding-index-in-v1.md) | No embedding index in v1 | Phase 4 |
| [0009](Docs/adr/0009-post-hoc-review.md) | Post-hoc review backed by checkpoints, superseding propose-then-apply | Phase 3 |

---

## Phase 0 — Foundation

**Goal:** Stand up the pnpm workspace, toolchain, packaging, and CI so that the architecture's boundaries are enforced by the build from the first commit rather than adopted later.

**Implements:** [ADR 0003](Docs/adr/0003-core-host-webview-split.md) · spec §3, §8.2, §8.3, §8.4

### Deliverables

- [ ] pnpm workspace monorepo, pnpm version pinned via corepack (**C6**).
- [ ] Five packages created with their dependency edges declared: `shared`, `core`, `host`, `webview-ui`, `extension` (spec §3).
- [ ] `shared` established with zero runtime dependencies.
- [ ] Strict TypeScript across all packages: `strict` enabled, `any` disallowed by lint rule (**C5**).
- [ ] ESLint configured, including the `no-restricted-imports` boundary rule forbidding `vscode`, `host`, and `webview-ui` imports in `core` (spec §3.1).
- [ ] esbuild build for `extension` and `host` producing a single CommonJS bundle.
- [ ] Vite build for `webview-ui` with hashed production assets.
- [ ] `.vsix` packaging via `@vscode/vsce`, bundling only built output.
- [ ] `engines.vscode` pinned to `^1.90.0` (spec §8.4).
- [ ] Vitest configured for `core`, `webview-ui`, and contract tests; `@vscode/test-electron` configured for `host`.
- [ ] GitHub Actions CI on every push and pull request: `install (frozen lockfile) → typecheck → lint (incl. boundary rule) → test (core, webview, contracts) → build → package .vsix → upload artifact`.
- [ ] The eight ADRs under [Docs/adr/](Docs/adr/) and this roadmap.

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- The CI pipeline runs end to end in the specified order and uploads a `.vsix` artifact.
- **The boundary rule is proven, not assumed:** a deliberate `import 'vscode'` added to `core` fails the lint step, and CI goes red. This is verified by test, then reverted.
- **No `any` is provable:** a deliberate `any` fails lint.
- `pnpm install --frozen-lockfile` succeeds from a clean checkout on the pinned pnpm version.
- The dependency graph matches `extension → host → core → shared` and `webview-ui → shared` exactly; no package declares a dependency flowing the other way.
- All eight ADRs and this roadmap are committed.

---

## Phase 1 — Agent Core

**Goal:** Make Claude work headlessly behind TARS's own provider seam, so orchestration and persistence are complete and tested before any UI exists.

**Implements:** [ADR 0001](Docs/adr/0001-claude-agent-sdk-as-integration-layer.md), [ADR 0004](Docs/adr/0004-normalized-agent-event-union.md), [ADR 0006](Docs/adr/0006-append-only-session-event-log.md) · spec §1.3, §3.2, §4

### Deliverables

- [ ] Provider abstraction in `packages/core/src/provider/types.ts`: `AgentProvider`, `AgentSession`, `ProviderCapabilities` (spec §4).
- [ ] `ClaudeCodeProvider` — the only module importing `@anthropic-ai/claude-agent-sdk` — adapting the SDK's `query()` message stream into `AgentEvent`.
- [ ] The full normalized event union: `text_delta`, `thinking_start`, `thinking_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_result`, `permission_request`, `plan_update`, `file_edit_proposed`, `usage`, `error`, `turn_end` (spec §4.1).
- [ ] Session lifecycle: `createSession`, `send`, `interrupt`, `dispose`.
- [ ] Normalized event bus consumed by `core` orchestration.
- [ ] Permission gating over the SDK's `canUseTool` hook, with per-tool policy `always_allow` / `ask` / `deny` and `ask` as the default for shell commands, file deletion, and network writes (spec §4.2).
- [ ] Append-only JSONL session log, one file per session under `globalStorageUri`, fsync-batched, with truncate-at-last-complete-record recovery (spec §4.3).
- [ ] All nine port interfaces declared in `core` with test fakes: `FileSystemPort`, `WorkspacePort`, `TerminalPort`, `GitPort`, `DiagnosticsPort`, `SecretsPort`, `StoragePort`, `ClockPort`, `LoggerPort` (spec §3.2).
- [ ] Authentication resolved through the SDK's credential chain (`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → on-disk OAuth profile), plus the optional override stored via `SecretsPort` (spec §1.3).

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- A conversation completes end to end headlessly, with no VS Code process involved, driven from a `core` test.
- `ClaudeCodeProvider` is covered by tests against a **fake** SDK stream; every member of the event union has at least one mapping test.
- `grep` across the repository confirms `@anthropic-ai/claude-agent-sdk` is imported by exactly one file.
- Exhaustive switches over `AgentEvent` compile without a default branch, proving the union is closed and fully handled.
- A `permission_request` round-trip is tested for all three policies: approval proceeds, denial returns a reason to the SDK, and `deny` policy never reaches the user.
- The session log is verified for the three features it exists to provide: replay reproduces the conversation, a checkpoint-style offset addresses a specific point in the stream, and a log truncated mid-record recovers to the last complete record.
- Log ordering assertions pass deterministically against the fake `ClockPort`, with no reliance on wall-clock time.
- No API key is written to `settings.json` by any code path.

---

## Phase 2 — Chat Shell

**Goal:** Ship the first installable `.vsix` — an editor UI that holds a streaming conversation over the user's codebase.

> **This is the first installable milestone.** At the end of phase 2 a `.vsix` installs in Cursor and holds a working streaming conversation over the user's codebase. Every later phase is additive, not architectural.

**Implements:** [ADR 0002](Docs/adr/0002-custom-webview-not-vscode-lm.md), [ADR 0005](Docs/adr/0005-react-vite-tailwind-webview.md) · spec §5

### Deliverables

- [ ] Activity Bar view contribution hosting the TARS webview.
- [ ] `shared` IPC contract: the `HostToWebview` and `WebviewToHost` discriminated unions plus a protocol version constant (spec §5.1).
- [ ] React 19 + Vite + Tailwind v4 webview shell with a Zustand store.
- [ ] Streaming chat: `text_delta` appends into the store; the message list is virtualized (spec §5.2).
- [ ] Thinking blocks rendered from `thinking_start` / `thinking_delta`.
- [ ] Tool timeline rendered from `tool_call_start` / `tool_call_delta` / `tool_call_result`.
- [ ] Permission approval affordance showing the tool, its arguments, and the affected paths (spec §4.2).
- [ ] `usage` and `error` surfaced in the UI.
- [ ] Theming: `var(--vscode-*)` custom properties mapped onto Tailwind theme tokens, dark mode as the design baseline (spec §5.3).
- [ ] Strict CSP: nonce'd inline scripts, no `unsafe-eval`, no external origins, all assets served from the extension's own URI (spec §5.4).
- [ ] Status bar item reflecting session state.
- [ ] Command palette commands and keybindings.
- [ ] `extension` composition root wiring `host` port implementations into `core`.

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- **The `.vsix` produced by CI installs in Cursor, VS Code, and VSCodium and holds a complete streaming conversation over a real workspace in each.** This is the milestone gate and is verified by manual installation in all three editors.
- Streaming text renders incrementally, not in one block at turn end.
- Interrupt cancels an in-flight turn from the UI and the session remains usable afterwards.
- A permission request is approved and denied from the UI, and both outcomes are observed to reach the SDK correctly.
- The webview imports neither `vscode`, nor any filesystem module, nor the Agent SDK — verified by lint and by inspection of the `webview-ui` dependency set.
- Both IPC unions round-trip in contract tests, and exhaustiveness is compiler-enforced on both sides (spec §8.1).
- The webview loads zero network resources: the CSP is active with no external origins, and no request leaves the page under a full conversation.
- The UI is legible and correctly themed under at least one dark and one light theme in each supported editor, with no hard-coded colours.
- `webview-ui` accessibility tests pass: keyboard navigation reaches every interactive affordance, and the conversation and permission prompts expose accessible roles and labels.
- A conversation of at least several hundred messages scrolls and continues streaming without visible paint degradation, confirming virtualization is effective.

---

## Phase 3 — Edit & Review

**Goal:** Let the agent propose edits that the user reviews per hunk, applies atomically into the editor's own undo stack, and can restore from.

**Implements:** [ADR 0007](Docs/adr/0007-native-diff-editor-and-workspaceedit.md) · spec §6

### Deliverables

- [ ] `ChangeSet` in `core`: a pure data structure of per-file hunks with before/after content hashes, accumulated from `file_edit_proposed` events (spec §6.1).
- [ ] Diff engine in `core` computing hunks; no rendering, no `vscode`.
- [ ] `TextDocumentContentProvider` in `host` supplying the proposed side to VS Code's **native diff editor** (spec §6.2).
- [ ] Review UI in the webview: per-hunk accept and reject, batch apply, change-set summary.
- [ ] Apply as a single `vscode.WorkspaceEdit` (spec §6.3).
- [ ] Content-addressed snapshot store under `globalStorageUri`, SHA-256 keyed, identical content stored once (spec §6.4).
- [ ] Checkpoint records referencing snapshot hashes plus the session event offset.
- [ ] Restore reconstructing a `WorkspaceEdit` from the snapshot, rewinding workspace and conversation as one operation.
- [ ] Pre-apply content-hash verification that invalidates hunks whose file changed on disk since proposal.

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- Diff computation, hunk accept/reject composition, checkpoint creation, and restore are unit-tested in `core` under Vitest with **no editor harness**.
- A multi-file change applies atomically: an induced failure mid-apply leaves the workspace entirely unchanged.
- `Ctrl+Z` immediately after an apply reverses the full change set, verified in all three supported editors.
- Restore returns every touched file to its pre-apply content byte for byte, and the conversation rewinds to the referenced session offset in the same operation.
- Restore is itself undoable, confirming it travels the same `WorkspaceEdit` path as apply.
- The content-addressed store is verified to store identical content once across repeated checkpoints of an unchanged file.
- A file modified externally between proposal and apply causes the affected hunks to be invalidated rather than the user's work overwritten.
- Rejected hunks are provably absent from the applied edit.
- No diff renderer exists in `webview-ui`; review is presented through the native diff editor.

---

## Phase 4 — Context Engine

**Goal:** Let the user steer precisely what enters context, curating rather than replacing the SDK's own retrieval.

**Implements:** [ADR 0008](Docs/adr/0008-no-embedding-index-in-v1.md) · spec §7

### Deliverables

- [ ] File index in `core`: incremental walk respecting `.gitignore`, backed by a file watcher through `FileSystemPort` and `WorkspacePort` (spec §7.2).
- [ ] Text search over `ripgrep`, which ships with VS Code — no bundled binary.
- [ ] Symbol navigation through `vscode.executeWorkspaceSymbolProvider`, reusing the user's installed language servers.
- [ ] `@`-mention resolution into typed context items for files, symbols, diagnostics, selections, and terminal output (spec §7.2).
- [ ] `@`-mention completion UI in the webview, driven by the file index.
- [ ] Context items attached to a turn and visible to the user before send.
- [ ] Typed context-item contract in `shared`, consumed by both `core` and `webview-ui`.

> **No embedding index and no vector store ship in v1** ([ADR 0008](Docs/adr/0008-no-embedding-index-in-v1.md), spec §7.1, §10).

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- Index construction, `.gitignore` handling, watcher-driven incremental updates, and `@`-mention resolution are unit-tested in `core` against an in-memory `FileSystemPort`.
- The index respects `.gitignore` exactly: ignored paths never appear in `@`-mention completion.
- Creating, renaming, moving, and deleting a file updates the index without a full rewalk, and no stale entry survives.
- Every `@`-mention kind — file, symbol, diagnostic, selection, terminal output — resolves to a typed context item and reaches the turn.
- `@`-mention completion returns results interactively on a large repository, with no blocking of the extension host.
- No embedding model, vector store, or embedding dependency is present in the dependency tree — verified by inspection.
- No search binary is bundled in the `.vsix`; text search uses the editor's own `ripgrep`.
- Symbol navigation degrades gracefully to no results when no language server is installed for a file's language, rather than erroring.

---

## Phase 5 — Integrations

**Goal:** Connect TARS to the surrounding developer environment — terminal, Git, MCP, workspace memory, and conversation history.

**Implements:** spec §3.2, §4.3 · builds on [ADR 0003](Docs/adr/0003-core-host-webview-split.md) ports and [ADR 0006](Docs/adr/0006-append-only-session-event-log.md)

### Deliverables

- [ ] `TerminalPort` real implementation over `vscode.window.createTerminal`, with terminal output resolvable as a context item.
- [ ] `GitPort` real implementation over the `vscode.git` extension API, feature-detected so TARS functions in a non-Git workspace.
- [ ] MCP server configuration surface, exposing the SDK's MCP capability and gated by the `mcp` capability flag.
- [ ] Workspace memory persisted through `StoragePort`.
- [ ] Conversation history UI: list past sessions and resume one by replaying its event log (spec §4.3).
- [ ] Retention policy for session logs and the content-addressed snapshot store.

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- Each new port has a `core`-side test against its fake (`TerminalPort` recording spy, `GitPort` fixture repository) and a thin `host`-side test under `@vscode/test-electron`.
- A past session is resumed from its log and continues correctly, with the replayed conversation matching the original.
- Terminal output resolves into a typed context item and reaches a turn.
- Git integration degrades gracefully: with the Git extension absent or the workspace not a repository, TARS functions with Git affordances hidden rather than erroring.
- An MCP server configured through the UI is reachable by the agent, and MCP affordances are hidden when `ProviderCapabilities.mcp` is false.
- Workspace memory survives an editor restart.
- The retention policy is verified to bound session-log and snapshot-store growth, and never deletes data referenced by a live checkpoint.
- `host` remains thin: no business logic is added to `host` that could have lived in `core`.

---

## Phase 6 — Hardening

**Goal:** Make v1.0 marketplace-ready — tested to the strategy in spec §8.1, inside declared performance budgets, security-reviewed, and documented.

**Implements:** spec §8, §10

### Deliverables

- [ ] Test suite complete against spec §8.1: `core` (Vitest, the bulk of coverage), `host` (`@vscode/test-electron`, thin), `webview-ui` (Vitest + React Testing Library, including accessibility and streaming render), contracts (IPC round-trip and exhaustiveness).
- [ ] Declared performance budgets with automated measurement: activation time, first-token latency, streaming paint under a long conversation, `@`-mention completion latency on a large repository, session replay time.
- [ ] Security review covering the permission model, CSP, credential handling through `SecretsPort`, MCP configuration, and the `Bash` tool's default `ask` policy.
- [ ] User documentation: installation, authentication precedence, permission policy configuration, review workflow, `@`-mentions, MCP setup.
- [ ] Contributor documentation: package topology, the dependency rule, port catalogue, and how to add a provider.
- [ ] Marketplace metadata and a `.vsix` validated for publication.
- [ ] Compatibility matrix verified across VS Code, Cursor, and VSCodium at the `^1.90.0` floor.
- [ ] Confirmation that every v1.0 non-goal in spec §10 holds in the shipped artifact.

### Exit criteria

- Build, lint, typecheck, and test all green in CI.
- Coverage is concentrated in `core` as spec §8.1 intends, and `host` carries no logic that should have been testable in `core`.
- Every declared performance budget is measured in CI and met; a regression past a budget fails the build.
- The security review is complete with no unresolved finding. Destructive and outward-facing operations — shell commands, file deletion, network writes — are confirmed to default to `ask`.
- No credential is written to `settings.json` or to any file in the workspace by any code path.
- No proposed API (`enabledApiProposals`) is used, and every API newer than `^1.90.0` is reached through a capability check with a baseline fallback (spec §8.4).
- The `.vsix` installs and passes a full manual smoke test — conversation, tool use, permission prompt, edit review, apply, undo, restore, `@`-mention, history resume — in VS Code, Cursor, and VSCodium.
- User and contributor documentation is complete and matches shipped behaviour; no documented feature is absent and no shipped feature is undocumented.
- The shipped artifact contains no telemetry, no embedding index, no remote execution path, and exactly one provider, confirming spec §10.
- `@vscode/vsce` reports the package as publication-valid.
