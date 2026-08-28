# ADR 0009 — Post-hoc review, backed by checkpoints

**Status.** Accepted. Supersedes the propose-then-apply flow originally described
in `TARS_SPEC.md` §6.

## Context

The spec originally described review as an approval gate: `file_edit_proposed`
events accumulate into a change set, the user approves, and TARS applies the
edits as a `WorkspaceEdit`.

That describes something that cannot happen. TARS uses the Agent SDK's own
`Write` and `Edit` tools (ADR 0004 — reuse SDK capabilities rather than
reimplementing them), and those tools write to the workspace themselves. The
`canUseTool` hook can hold a tool before it runs or refuse it outright, but it
cannot take the write and defer it. There is no point at which TARS holds
proposed content that is not already on disk.

## Decision

Review is **post-hoc**. Safety rests on two mechanisms that are real rather than
one that is not:

1. The **permission gate** (§4.2) runs before the write. `Write` and `Edit`
   default to `ask`, so the user's approval precedes the edit.
2. The **checkpoint** (§6.4) is taken before the write, from the
   `file_edit_proposed` event the SDK emits before the tool executes. The
   pre-edit content therefore always exists somewhere.

The user then decides, per hunk in the editor (§6.5) or per turn from the chat
panel, whether to keep what landed or revert it. The UI says "already written to
disk" rather than offering an Apply button that would misdescribe the state.

## Alternatives considered

**Supply replacement file tools over MCP, so TARS owns the write.** Rejected: it
reimplements the SDK's editing tools, diverges from their behaviour on every SDK
release, and loses `Edit`'s partial-match semantics — which is the tool the agent
uses most.

**Set `permissionMode: 'plan'` and apply the plan ourselves.** Rejected: plan
mode changes what the agent does, not only how its output is delivered. It is a
different product, not a different review flow.

**Say nothing and present the change set as pending.** Rejected outright. A user
who closed the panel believing nothing had happened would be wrong in the most
expensive direction.

## Consequences

- The checkpoint is load-bearing rather than a convenience, so it is written
  after *each* file rather than at turn end: a crash mid-turn must still leave a
  way back.
- "Discard" becomes "Revert", and is a real filesystem operation rather than
  dropping a buffer. It goes through a `WorkspaceEdit` so it lands in the
  editor's undo stack (§6.3).
- The permission prompt carries more weight than originally planned, since it is
  the only gate that precedes the write. That is why the single "Allow" button
  was split into "Allow once" and "Always allow" — a session-wide promotion must
  not be reachable by a user who thinks they are approving one invocation.
