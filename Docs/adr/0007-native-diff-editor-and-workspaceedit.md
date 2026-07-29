# ADR 0007 — Native VS Code diff editor and `WorkspaceEdit` for review and apply

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §6, §6.1, §6.2, §6.3, §6.4, §3.1

## Context

Phase 3 delivers the edit and review loop: the agent proposes changes, the user inspects them, accepts or rejects per hunk, applies the survivors, and can restore afterwards. Two questions dominate its design — how changes are *shown*, and how they are *committed to disk*.

The default instinct for a chat-based agent UI is to render diffs inside the webview, alongside the conversation. It keeps everything in one surface and gives complete control over presentation. But a diff viewer is not a small component. Doing it properly means syntax highlighting, intraline highlighting, whitespace handling, word wrap, folding of unchanged regions, side-by-side and inline modes, keyboard navigation, screen-reader support, and correct behaviour on very large files. VS Code already ships all of that, tuned, accessible, and — critically — configured by the user. A bespoke viewer would not merely duplicate it; it would *diverge* from the diff settings the user has already chosen, and the divergence would be visible on every review.

The apply path has a sharper version of the same problem. Writing files directly through `workspace.fs` puts the change outside the editor's undo history. `Ctrl+Z` would then either do nothing or undo something unrelated, and the natural fix — a bespoke undo stack for AI edits — creates a second, competing history that users must learn and that will disagree with the editor's at the boundaries. Undo is one of the highest-frequency interactions in an editor and one of the least tolerant of surprise.

There is also a boundary consideration. [ADR 0003](0003-core-host-webview-split.md) forbids `core` from importing `vscode`, and diff computation is pure logic that belongs in `core` and must be unit-testable there. Presentation and application, by contrast, are inherently editor operations. The split is therefore natural rather than imposed: `core` computes, `host` renders and applies.

## Decision

`file_edit_proposed` events accumulate into a **`ChangeSet`** in `core` — a pure data structure describing per-file hunks with before/after content hashes. `core` computes the change set and owns all diff logic; it renders nothing.

`host` presents the change set through **VS Code's native diff editor**, using a virtual document `TextDocumentContentProvider` to supply the proposed side. TARS contributes the **review workflow** — accept and reject per hunk, batch apply — and not a diff renderer.

Accepted edits apply as a **single `vscode.WorkspaceEdit`**. This is atomic and lands in the editor's **own undo stack**, so `Ctrl+Z` reverses an AI edit exactly as it reverses a human one. There is no bespoke undo system.

Before any apply, `core` snapshots the content of every touched file into a content-addressed store under `globalStorageUri`, SHA-256 keyed, so identical content is stored once. A checkpoint record references those hashes plus the session event offset. Restore reconstructs a `WorkspaceEdit` from the snapshot — so restore travels the same atomic, undoable path as apply. Because checkpoints reference the session log offset, restoring workspace state and rewinding the conversation are the same operation ([ADR 0006](0006-append-only-session-event-log.md)).

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Custom diff viewer in the webview** | Everything in one surface: diff, conversation, and per-hunk controls adjacent, with total control over presentation and the tightest possible review interaction. | Duplicates a mature, accessible, theme-aware component the editor already ships, and diverges from the user's configured diff settings. It also makes TARS responsible for syntax highlighting, large-file performance, and screen-reader behaviour in a diff — a large permanent cost for presentation, not for the workflow that is actually TARS's contribution. |
| **Write files directly via `workspace.fs`** | Simplest apply path, no `WorkspaceEdit` construction, works uniformly whether or not a document is open in an editor. | Bypasses the editor's undo stack. `Ctrl+Z` would not reverse an AI edit, which is a serious violation of user expectation, and it forfeits atomicity across a multi-file change. |
| **Bespoke undo stack for AI edits** | Undo semantics tailored to the agent: undo a whole turn, or a whole change set, as one unit regardless of editor state. | Creates a second history competing with the editor's. Users would face two undo mechanisms with different scopes that disagree at the boundaries. `WorkspaceEdit` already gives per-change-set atomicity inside the editor's own stack. |
| **Git-based review — apply to a branch, review with the user's Git tooling** | Reuses tooling users already trust, with excellent diffing and a natural revert path. | Mutates the user's repository history, which is state the user owns and controls, and fails outright for workspaces that are not Git repositories. Checkpoints in a private content-addressed store have neither problem. |
| **Auto-apply everything, review after the fact** | Fastest loop, no review friction, and the agent stays in flow. | Removes the safety property phase 3 exists to provide. Review before apply, plus permission gating (§4.2), is how autonomy stays trustworthy. Checkpoints support after-the-fact recovery; they do not replace consent. |
| **Diff computation in `host` using editor APIs** | Could reuse editor diffing primitives instead of implementing hunk logic. | Violates [ADR 0003](0003-core-host-webview-split.md): the change set is business logic and must be unit-testable in plain Node. Diff logic in `host` would be reachable only through `@vscode/test-electron`. |

## Consequences

### Positive
- A mature, accessible, theme-aware diff surface at zero maintenance cost, honouring the user's own diff configuration in VS Code, Cursor, and VSCodium alike.
- `Ctrl+Z` behaves exactly as users expect on an AI edit, with no bespoke undo system to build, document, or reconcile.
- Multi-file changes are atomic: one `WorkspaceEdit` either lands entirely or not at all.
- Restore uses the same apply path, so restoring is itself undoable and atomic.
- `ChangeSet` is a pure data structure in `core`, so hunk computation, accept/reject composition, and content-hash verification are fully unit-testable under Vitest with no editor.
- Content-addressed snapshots deduplicate identical file content, keeping checkpoint storage proportional to distinct content rather than to checkpoint count.
- TARS invests its effort in the review *workflow*, which is genuinely differentiating, rather than in a diff renderer, which is not.

### Negative
- Review happens in a diff editor tab, not inside the chat panel, so the user moves between two surfaces. Presentation is bounded by what the native diff editor offers — TARS cannot add inline affordances the editor does not support.
- Per-hunk accept and reject must be expressed through the virtual document and TARS's own controls rather than as native diff-editor gutter actions, because the editor's diff view is not an editing surface TARS owns.
- `WorkspaceEdit` behaviour is the editor's, so any fork-specific divergence in how it handles concurrent edits, formatters, or save-on-apply is inherited rather than controlled.
- Content hashes must be re-verified immediately before apply; a file changed on disk between proposal and apply must invalidate the affected hunks rather than overwrite the user's work.

### Neutral / accepted costs
- A `TextDocumentContentProvider` and its URI scheme must be registered and lifecycle-managed in `host`.
- Two representations of a change exist: `core`'s `ChangeSet` and the `WorkspaceEdit` derived from it at apply time. The derivation is `host`'s responsibility and is thin by design.
- Snapshot storage grows with the number of distinct file versions touched, which — as with the session log ([ADR 0006](0006-append-only-session-event-log.md)) — requires a retention policy before v1.
- Review is mandatory before apply for gated operations; the loop is deliberately not fully autonomous.

## Revisit If
- The native diff editor cannot express a review affordance that user testing shows is essential to the workflow, and no host-side control compensates. Only then does a custom viewer's cost become justified.
- `WorkspaceEdit` behaves inconsistently across VS Code, Cursor, and VSCodium in a way that breaks atomicity or undo, which would force a direct-write path plus explicit undo handling.
- Change sets routinely exceed a size the native diff editor handles within phase 6's performance budgets, requiring a chunked or summarized presentation.
- Content-hash invalidation on concurrent external edits proves too coarse in practice — rejecting whole change sets over unrelated file changes — requiring finer-grained conflict resolution in `core`.
- Snapshot storage growth cannot be contained by a retention policy, requiring a different checkpoint substrate.
