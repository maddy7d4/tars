# TARS — Architecture Specification

**Status:** Approved
**Date:** 2026-07-30
**Scope:** Foundational architecture for TARS v1.0 (phases 0–6)

---

## 1. Mission & Constraints

TARS is a production-grade AI engineering platform delivered as a VS Code extension, packaged as a `.vsix`, installable without modifying the editor. It must run in VS Code, Cursor, VSCodium, and compatible forks.

### 1.1 Hard constraints (these eliminate design branches, not merely guide them)

| # | Constraint | Consequence |
|---|---|---|
| C1 | Must run in Cursor and VSCodium | `vscode.lm` (Language Model API) and the Chat Participant API are Copilot-gated and fork-unstable. **TARS cannot use them.** UI is a custom webview; the model arrives via the Agent SDK. |
| C2 | Never use Cursor private APIs; never patch or reverse-engineer the editor | Only documented, stable `vscode` extension APIs. Proposed APIs are permitted only behind a capability check with a graceful fallback. |
| C3 | The workspace lives on the user's disk | Rules out Anthropic **Managed Agents** (agent loop + sandbox hosted remotely). Tool execution must be local. |
| C4 | `claude.md`: "Reuse SDK capabilities instead of reimplementing them" | Rules out building an agent loop on the raw Messages API. The **Claude Agent SDK** is the correct integration layer. |
| C5 | `claude.md`: strong typing, no `any`, modular packages, UI separate from business logic, no monolith | Enforced mechanically in CI, not by convention. |
| C6 | `claude.md`: pnpm | pnpm workspace monorepo, version-pinned via corepack. |

### 1.2 Provider decision

Three integration layers exist for Claude. Only one fits:

- **Managed Agents** — Anthropic hosts the loop and a per-session container. Violates C3.
- **Messages API + Tool Runner** — requires reimplementing the agent loop, context compaction, permissions, and subagents. Violates C4.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code packaged as a library: built-in `Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`/`WebSearch`/`WebFetch`, the full agent loop, context management, hooks, subagents, permissions, and sessions. Harness-only; TARS hosts it. **Selected.**

The SDK is at `0.3.x` — pre-1.0. The provider abstraction (§4) is therefore load-bearing insulation against breaking changes, not speculative generality.

### 1.3 Authentication

The Agent SDK resolves credentials through the standard Anthropic precedence chain: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → the OAuth profile on disk from an existing `claude` login.

Consequence: **users who already use Claude Code get zero-config auth.** TARS builds no login flow. It offers an optional override stored via `SecretsPort` (OS keychain) for teams that inject an explicit key. An API key is never written to `settings.json`, which users commit.

---

## 2. Delivery Plan

The full brief spans ~25 components. That is a program of work, not one spec. It decomposes into independently shippable phases, each with its own design → plan → implement cycle.

| Phase | Delivers | Depends on |
|---|---|---|
| **0 — Foundation** | pnpm workspace, package skeleton, strict TS, build/bundle, `.vsix` packaging, CI, ADRs, roadmap | — |
| **1 — Agent Core** | Provider abstraction, Claude Code provider, session lifecycle, normalized event bus, session log | 0 |
| **2 — Chat Shell** | Activity Bar view, webview UI, streaming chat, tool timeline, status bar, commands, keybindings | 0, 1 |
| **3 — Edit & Review** | Diff engine, change sets, apply/reject, checkpoints, review UI | 1, 2 |
| **4 — Context Engine** | Workspace indexing, repo search, symbol navigation, `@`-mentions | 1, 2 |
| **5 — Integrations** | Terminal, Git, MCP configuration, workspace memory, conversation-history UI | 1, 2 |
| **6 — Hardening** | Test suite, performance budgets, security review, documentation, marketplace-ready v1.0 | all |

Phase 4 depends on phase 2, not phase 1 alone: `@`-mention completion is a webview surface, so the UI must exist before the context engine has anywhere to surface itself.

**Two distinct packaging milestones, easily conflated:**

- Phase 0 delivers the packaging **pipeline** — `pnpm package` produces a `.vsix` and CI uploads it as an artifact. That artifact activates and loads its webview, but does nothing useful yet. Its purpose is to prove the toolchain end-to-end before any feature depends on it.
- Phase 2 delivers the first **useful** install: a `.vsix` that installs in Cursor and holds a working streaming conversation over the user's codebase.

Every later phase is additive, not architectural. The repository must build, lint, typecheck, and test green at the end of every phase.

---

## 3. Package Topology

```
packages/
  shared/       Types + IPC message contracts. Zero runtime dependencies.
  core/         Pure TypeScript. NO vscode import (CI-enforced).
                Agent orchestration · provider registry · diff engine
                context engine · memory · checkpoints · planner
  host/         The ONLY package that imports vscode.
                Implements core's ports; owns commands, views, status bar.
  webview-ui/   React 19 + Vite + Tailwind v4.
  extension/    Activation entry. Composition root — wires host impls into core.
```

### 3.1 The dependency rule

Dependencies flow strictly one way:

```
extension → host → core → shared
webview-ui → shared
```

Nothing flows back. `core` importing `vscode`, `host`, or `webview-ui` is a **CI failure**, enforced by an ESLint `no-restricted-imports` rule. A boundary not enforced by the build erodes; this one is mechanical.

**Rationale.** With no `vscode` import in `core`, the agent orchestration, diff engine, indexer, and checkpoint logic are unit-testable in plain Node with no VS Code harness. This is what makes phases 3–5 tractable — those subsystems are otherwise only reachable through slow, flaky integration tests. It also preserves the option to lift `core` into a sidecar daemon later as a pure transport change, touching zero business logic.

### 3.2 Ports

`core` defines interfaces; `host` supplies real implementations; tests supply fakes.

| Port | Real implementation (host) | Test implementation |
|---|---|---|
| `FileSystemPort` | `vscode.workspace.fs` | in-memory volume |
| `WorkspacePort` | folders, configuration, open editors | fixture object |
| `TerminalPort` | `vscode.window.createTerminal` | recording spy |
| `GitPort` | `vscode.git` extension API | fixture repository |
| `DiagnosticsPort` | `vscode.languages` | static list |
| `SecretsPort` | `ExtensionContext.secrets` (OS keychain) | in-memory map |
| `StoragePort` | `globalStorageUri` / `workspaceStorageUri` | temp directory |
| `ClockPort` | `Date.now` | deterministic counter |
| `LoggerPort` | `vscode.window.createOutputChannel` | buffer |

`ClockPort` is not over-abstraction: anything timestamped (checkpoints, session logs, and any future telemetry — itself a v1 non-goal, §10) is untestable against a real clock and produces flaky ordering assertions. Injecting time is cheap now and painful to retrofit in phase 3.

`SecretsPort` is a security boundary, not plumbing — it keeps credentials in the OS keychain rather than in committed configuration.

---

## 4. Provider Abstraction & Normalized Events

The load-bearing seam of the system.

```ts
// packages/core/src/provider/types.ts

interface AgentProvider {
  readonly id: ProviderId;                 // 'claude-code'
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  createSession(opts: SessionOptions): Promise<AgentSession>;
}

interface AgentSession {
  readonly id: SessionId;
  send(input: UserTurn): void;
  interrupt(): void;
  readonly events: AsyncIterable<AgentEvent>;
  dispose(): void;
}

interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly thinking: boolean;
  readonly subagents: boolean;
  readonly mcp: boolean;
  readonly permissionGating: boolean;
  readonly sessionResume: boolean;
}
```

### 4.1 The normalized event union

Every provider maps its native stream into one union. This is the contract `core` orchestration and `webview-ui` consume:

```
turn_start          text_delta
thinking_start      thinking_delta      thinking_end
tool_call_start     tool_call_delta     tool_call_result
permission_request  plan_update         file_edit_proposed
usage               error               turn_end
```

**Block boundaries are explicit, never inferred.** `turn_start`/`turn_end` and `thinking_start`/`thinking_end` are emitted as matched pairs. The alternative — deducing that a block closed because an event of a different type arrived — breaks on the first interleaved stream, and Claude interleaves thinking with tool calls: a `tool_call_start` does not mean thinking finished, because thinking may resume afterwards. Without terminators a collapsed thinking panel either never closes or closes too early. Two extra union members buy the removal of a whole class of streaming-UI bug.

`ClaudeCodeProvider` is the **only** module permitted to import `@anthropic-ai/claude-agent-sdk`. It adapts the SDK's `query()` message stream into `AgentEvent`.

**Rationale.** The SDK is pre-1.0 and will introduce breaking changes. Because neither the orchestrator nor the React UI has ever seen an SDK type, the blast radius of an SDK upgrade is one adapter file. Without this seam, an SDK breaking change is a whole-application refactor.

### 4.2 Permission gating

`permission_request` maps onto the SDK's `canUseTool` hook. The flow:

1. SDK proposes a tool invocation.
2. Adapter emits `permission_request` and holds the promise.
3. Webview renders an approval affordance showing the tool, its arguments, and the affected paths.
4. User decision resolves the promise; the SDK proceeds or receives a denial with a reason.

Autonomy and safety therefore share one mechanism rather than safety being bolted on afterwards. Policy is configurable per tool: `always_allow`, `ask`, `deny`. Destructive and outward-facing operations (shell commands, file deletion, network writes) default to `ask`.

### 4.3 Session persistence

A session is an **append-only event log** — JSONL, one file per session, under `globalStorageUri`. Writes are append-only and fsync-batched.

One primitive yields three features: conversation history (replay the log), checkpoint/restore (§6), and crash recovery (truncate at the last complete record). Three subsystems collapse into one.

Ownership across phases: **phase 1 owns the log primitive** — writing, replaying, and truncating it. **Phase 5 owns the history UI** — browsing, searching, and resuming past sessions. The §2 table's phase 5 entry is therefore the surface, not the storage.

---

## 5. Webview State & IPC

### 5.1 Typed message contract

`shared/` owns two discriminated unions — `HostToWebview` and `WebviewToHost` — plus a protocol version constant. Both sides exhaustively switch; TypeScript rejects unhandled variants.

The webview never touches `vscode`, the filesystem, or the SDK. It renders state and emits intents. All privilege lives in `host`.

### 5.2 State management

Zustand store in `webview-ui`. Chosen over Redux (boilerplate) and raw Context (re-render storms under token streaming). Streaming `text_delta` events append into the store; the message list is virtualized so a long conversation does not degrade paint time.

### 5.3 Theming

VS Code exposes theme colours as CSS custom properties (`var(--vscode-*)`). These map onto Tailwind theme tokens, so TARS inherits the user's theme — including Cursor and VSCodium themes — with no per-theme code. Dark mode is the design baseline.

### 5.4 Content Security Policy

Strict CSP: nonce'd inline scripts, no `unsafe-eval`, no external origins. All assets bundled and served from the extension's own URI. The webview loads nothing from the network.

---

## 6. Edit, Review & Checkpoints

### 6.0 Review is post-hoc, and why

**Corrected during phase 3 implementation.** This section originally described a
propose-then-apply flow, in which edits were held in a change set until the user
approved them. That describes something that cannot happen.

TARS uses the Agent SDK's own `Write` and `Edit` tools (ADR 0004 — reuse SDK
capabilities rather than reimplementing them). Those tools write to the workspace
themselves. `canUseTool` can hold a tool *before* it runs or refuse it outright,
but it cannot take the write and defer it, so there is no point at which TARS
holds proposed content that is not already on disk.

The safety property therefore rests on two things that are real, rather than one
that is not:

1. **The permission gate (§4.2) runs before the write.** Destructive and
   outward-facing tools default to `ask`, so the user's approval precedes the
   edit, not the review.
2. **The checkpoint (§6.4) is taken before the write.** Every file is snapshotted
   the moment the agent announces it will edit it — which the SDK emits before
   the tool executes — so the pre-edit content always exists somewhere.

Review is then an honest **keep or revert** decision over changes that have
already landed, not an approval gate pretending they have not. The UI says
"already written to disk" for the same reason.

The alternative — supplying replacement file tools via MCP so TARS owned the
write — was rejected: it would reimplement the SDK's editing tools, diverge from
their behaviour on every SDK release, and lose `Edit`'s partial-match semantics.

### 6.1 Change sets

`file_edit_proposed` events accumulate into a `ChangeSet` in `core` — a pure data
structure describing per-file hunks with before/after content hashes. Repeated
proposals for one file fold into a single entry measured against the original
baseline, since the net effect is what the user decides about.

A change carries a `stale` flag when the content the edit was computed against is
not the content the baseline holds. Staleness is surfaced, never resolved
automatically: rebasing would apply an edit whose context the model never saw,
and dropping it would lose work.

### 6.2 Diff presentation

`core` computes the change set; `host` renders it through **VS Code's native diff
editor** via a virtual document `TextDocumentContentProvider` under the
`tars-diff` scheme, which serves the pre-edit baseline that no longer exists on
disk.

**Rationale.** Reimplementing a diff viewer inside the webview would duplicate a
mature, accessible, theme-aware component the editor already ships — and it would
diverge from the user's configured diff settings. TARS contributes the *review
workflow*, not a diff renderer.

### 6.3 Applying edits

Reverts and checkpoint restores apply as a single `vscode.WorkspaceEdit`. This is
atomic and lands in the editor's **own undo stack**, so `Ctrl+Z` reverses a TARS
revert exactly as it reverses a human edit — no bespoke undo system, and no
surprising divergence from user expectation. A user who reverts by mistake gets
their work back with `Ctrl+Z` rather than needing a second TARS command.

### 6.4 Checkpoints

Before the agent's first write of a turn, `core` snapshots the content of every
touched file into a content-addressed store under `globalStorageUri` (SHA-256
keyed; identical content stored once). A checkpoint record references those
hashes plus the session event offset, and is extended — and re-persisted — as
each further file is touched, so a crash mid-turn still leaves a way back.

The first snapshot of a path wins: a later baseline would be the agent's own
output, which is the one state nobody needs to return to.

Restore reconstructs a `WorkspaceEdit` from the snapshot. Because checkpoints
reference the session log offset, restoring state and rewinding the conversation
are the same operation. A blob that cannot be read is reported by path rather
than failing the restore, so nine recovered files plus a named casualty beats an
all-or-nothing refusal.

### 6.5 In-editor hunk review

Review happens **where the change is**: the edited file is brought forward, its
changed regions are coloured, and each one carries Accept and Reject. A change
the user has to navigate to is a change most users will not look at, and the
chat panel's file list is therefore a way *into* the editor rather than a review
surface of its own.

**State is one string per file — the baseline.** Hunks are never stored. They are
recomputed from `(baseline, document text)` whenever anything moves, which is
what lets the user type mid-review, undo, save, or let the agent write again
without any decision going stale. The two operations are asymmetric, and that
asymmetry is what removes the bookkeeping:

| Action | Effect |
| --- | --- |
| **Reject hunk** | Rewrites the *file*, restoring that region from the baseline. |
| **Accept hunk** | Rewrites the *baseline*, absorbing that region from the file. |

An accepted hunk therefore stops being a hunk on the next computation, with no
"accepted" set to maintain and no cached line range to invalidate. Both converge
on "the two texts agree", from opposite directions, at which point the file
leaves review.

Rejections are applied as a `WorkspaceEdit` for the reason in §6.3: a user who
rejects by mistake presses `Ctrl+Z`, not another TARS command.

**Rendering deletions.** Removed lines are not in the document, and the public
VS Code API has no way to insert a phantom line — editors that show deletions as
red rows do it by patching the editor, which TARS will not do (constraint C1).
A deletion is therefore rendered as a red marker on the line that replaced it,
carrying the removed text inline and the full block in the hover, with the
side-by-side diff one click away. Less pretty than a phantom row, and it loses
nothing.

Per-hunk controls are `CodeLens`: a public API, keyboard reachable, scrolling
with the code it belongs to, and inheriting the user's font and theme. A custom
overlay would need absolute positioning that breaks on wrapped lines and folded
regions, and would be invisible to a screen reader.

**Whole-file controls** (`Keep`, `Revert`) remain in the chat panel and act on
the whole turn, backed by the checkpoint. The per-hunk controls and the
whole-turn controls are independent: the former move the baseline, the latter
restore it.

---

## 7. Context Engine

### 7.1 Principle: curate, do not replace

The Agent SDK already ships `Glob`, `Grep`, `Read`, and `WebFetch`, and Claude uses them competently. TARS's value is **curation** — deciding what enters context and letting the user steer it — not rebuilding retrieval.

**v1 ships no embedding index.** A vector store adds an embedding pipeline, a model dependency, cache invalidation, and disk growth, in exchange for gains the SDK's own search largely already delivers on a single repository. Deferred until measurement justifies it.

### 7.2 Composition

- **File index** — incremental walk respecting `.gitignore`, backed by a file watcher. Powers `@`-mention completion and fast path resolution.
- **Text search** — `ripgrep`, which ships with VS Code. No bundled binary.
- **Symbol navigation** — `vscode.executeWorkspaceSymbolProvider`. Reuses whatever language servers the user already has installed rather than shipping parsers for N languages. TARS gets accurate symbols for every language the user's editor supports, for free.
- **`@`-mentions** — resolve files, symbols, diagnostics, selections, and terminal output into typed context items attached to a turn.

### 7.3 Index freshness

`WorkspaceIndex` owns the `FileIndex` and keeps it current from `FileWatcherPort`.

The initial walk is **deferred to first use**, not done at activation: it is the
most expensive thing TARS does at startup, and a window whose panel is never
opened should not pay for it. Watching begins only after that walk completes —
subscribing earlier would apply changes to an index still being built, which the
walk would then overwrite.

Creations and deletions update the index incrementally, in O(1). A creation is
checked against the ignore rules gathered during the walk, because the watcher
reports build output: without that check, a project compiling into `dist/` would
fill the index with generated files the moment it was built — precisely when the
user is least likely to notice their completions went bad. Content edits change
nothing, since the index holds paths.

A change to any `.gitignore` forces a **debounced rebuild**. Ignore rules can
hide or reveal whole subtrees, which no incremental update can express; the
debounce exists because a branch switch rewrites `.gitignore` alongside
everything else, and a walk per event would turn a checkout into a stall.

### 7.4 Mention completion

Completion is a **round trip to the host**, not a local filter over a pushed file
list. Resolving a path is privileged and the index lives behind the port
boundary (§5.1), so pushing every workspace path across `postMessage` on connect
would be both a large message and a leak of workspace shape into the sandbox.

Three sources merge: the file index, workspace symbols, and the editor-state
aliases (`@selection`, `@problems`). Files come first because that is what users
mention overwhelmingly most. Symbols are requested concurrently but abandoned
after a deadline — a language server still starting must not delay the list past
the point where the user has finished typing. Showing files now beats showing
everything later.

Replies carry the query they answer, so a late response for a prefix the user has
typed past is discarded rather than repopulating the list with stale matches.

Mentions are resolved host-side on send. Anything that resolved is **stripped**
from the prose, since it is carried structurally and would otherwise reach the
model twice; anything that did not is **left in place and reported**, because a
user who typed `@thing.ts` and silently got nothing would believe they had
attached a file.

---

## 8. Testing, CI & Packaging

### 8.1 Test strategy

| Layer | Tool | What it covers |
|---|---|---|
| `core` | Vitest (plain Node) | Orchestration, providers (fake SDK), diff, checkpoints, index. Fast; the bulk of coverage. |
| `host` | `@vscode/test-electron` | Port implementations against a real editor. Thin by design. |
| `webview-ui` | Vitest + React Testing Library | Component behaviour, accessibility, streaming render. |
| contracts | Vitest | IPC unions round-trip; exhaustiveness. |

Coverage concentrates in `core` precisely because the dependency rule made it cheap to test there. `host` stays thin so that little logic requires the slow harness.

### 8.2 Build

- `extension` and `host` → **esbuild** (fast, tree-shaking, single CommonJS bundle as VS Code expects).
- `webview-ui` → **Vite** (HMR in development, hashed assets in production).
- `.vsix` → `@vscode/vsce`, bundling only built output.

### 8.3 CI

GitHub Actions, on every push and pull request:

```
install (frozen lockfile) → typecheck → lint (incl. boundary rule)
  → test (core, webview, contracts) → build → package .vsix → upload artifact
```

The boundary rule failing is a red build. Every phase ends green.

### 8.4 Compatibility

`engines.vscode` is pinned to **`^1.90.0`**. Cursor and VSCodium track upstream VS Code at a lag, so the baseline must sit below the oldest fork TARS supports rather than at the newest upstream release. Raising this floor is a deliberate, ADR-worthy decision — not something a dependency bump does incidentally.

Any API newer than the baseline is feature-detected with a graceful fallback, never assumed present:

```ts
// host: capability check, never a bare call
if (typeof vscode.window.someNewerApi === 'function') { /* enhanced path */ }
else { /* baseline path */ }
```

No proposed (`enabledApiProposals`) API is used: proposed APIs require a flag the marketplace does not permit and forks do not reliably ship.

---

## 9. Architecture Decision Records

Each decision below is recorded as a separate file under `Docs/adr/`, written as part of phase 0. The ADR is the durable record of *why*; this spec records *what*.

| ADR | Decision |
|---|---|
| 0001 | Claude Agent SDK as the integration layer |
| 0002 | Custom webview instead of `vscode.lm` / Chat Participant API |
| 0003 | Core/host/webview split with CI-enforced dependency rule |
| 0004 | Normalized `AgentEvent` union at the provider seam |
| 0005 | React + Vite + Tailwind for the webview |
| 0006 | Append-only session event log as the persistence primitive |
| 0007 | Native VS Code diff editor and `WorkspaceEdit` for review and apply |
| 0008 | No embedding index in v1 |

---

## 10. Non-Goals for v1.0

Explicitly out of scope, recorded so they are not re-litigated:

- Providers other than Claude Code. The abstraction admits them; v1 ships one.
- Embedding / vector retrieval (§7.1).
- A sidecar daemon. The architecture preserves the option; v1 runs in the extension host.
- Remote or cloud execution. Tool execution is local (C3).
- Telemetry. If added later, opt-in and documented before any collection.
