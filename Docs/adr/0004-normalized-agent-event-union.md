# ADR 0004 — Normalized `AgentEvent` union at the provider seam

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §1.2, §4, §4.1, §4.2, §5.1

## Context

[ADR 0001](0001-claude-agent-sdk-as-integration-layer.md) commits TARS to the Claude Agent SDK, `@anthropic-ai/claude-agent-sdk`, and records the residual risk plainly: the SDK is pre-1.0 (`0.3.x`) and will introduce breaking changes. The question this ADR answers is where that risk is allowed to land.

The naive integration consumes the SDK's `query()` message stream directly. The orchestrator switches on SDK message types; the Zustand store holds SDK message objects; React components render SDK fields. It works, and it is fast to write. Its cost appears at the first breaking change: SDK types are now spread across orchestration, IPC contracts, store shape, and component props, so a rename in the SDK's message stream is a whole-application refactor with a compiler error in every package. That is not a hypothetical for a pre-1.0 dependency — it is the expected case.

There is a second, independent force. The webview must render things the SDK stream does not name as such: a thinking block opening, a tool call accumulating arguments, a permission prompt awaiting a decision, a proposed file edit heading for review, a plan update, token usage. These are *UI-meaningful* events. Deriving them ad hoc in components means the UI encodes assumptions about SDK stream shape, and those assumptions are invisible to the type system.

Finally, spec §10 records that v1 ships one provider while the abstraction admits others. The seam is not built for that hypothetical second provider — it is built because the *first* provider is a moving target. Multi-provider support is a free consequence, not the motivation.

## Decision

`core` defines a provider abstraction — `AgentProvider`, `AgentSession`, `ProviderCapabilities` — in `packages/core/src/provider/types.ts`. Every provider maps its native stream into one normalized discriminated union, `AgentEvent`, exposed as `AsyncIterable<AgentEvent>` on `AgentSession.events`. This union is the contract that `core` orchestration and `webview-ui` consume:

| Event | Meaning |
|---|---|
| `turn_start` | The turn has opened. Exactly one per turn, before any other event. |
| `text_delta` | Incremental assistant text. Appended into the store as it streams. |
| `thinking_start` | An extended-thinking block has opened. |
| `thinking_delta` | Incremental thinking content. |
| `thinking_end` | The extended-thinking block has closed. One per `thinking_start`. |
| `tool_call_start` | A tool invocation has begun; identifies the tool. |
| `tool_call_delta` | Incremental tool arguments. |
| `tool_call_result` | The tool's outcome. |
| `permission_request` | A tool invocation is awaiting a user decision (§4.2). |
| `plan_update` | The agent's plan has changed. |
| `file_edit_proposed` | An edit is proposed for review; accumulates into a `ChangeSet` (§6.1). |
| `usage` | Token usage for the turn. |
| `error` | A failure surfaced to the user. |
| `turn_end` | The turn is complete. |

`ClaudeCodeProvider` is the **only** module in the entire repository permitted to import `@anthropic-ai/claude-agent-sdk`. Its sole responsibility is adapting the SDK's `query()` message stream into `AgentEvent`. Neither the orchestrator nor any React component ever sees an SDK type.

`ProviderCapabilities` declares what a provider supports — `streaming`, `thinking`, `subagents`, `mcp`, `permissionGating`, `sessionResume` — so the UI enables affordances from a declared capability rather than from a provider identity check.

`permission_request` maps onto the SDK's `canUseTool` hook. The adapter emits the event and holds the promise; the webview renders an approval affordance showing the tool, its arguments, and the affected paths; the user's decision resolves the promise, and the SDK either proceeds or receives a denial with a reason. Policy is configurable per tool — `always_allow`, `ask`, `deny` — with destructive and outward-facing operations (shell commands, file deletion, network writes) defaulting to `ask`. Autonomy and safety therefore share one mechanism instead of safety being bolted on afterwards.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Consume SDK message types directly** | Least code, no mapping layer, no drift between two representations, and new SDK stream features are available the moment they ship. | Blast radius. An SDK breaking change becomes a whole-application refactor, because SDK types would reach orchestration, the IPC contract, the store, and component props. With a pre-1.0 dependency this is the expected case, not the tail risk. |
| **Adapter, but pass SDK payloads through opaquely** | Cheap middle ground — one wrapper type, no per-field mapping to maintain. | Only relocates the problem. Consumers must still read SDK-shaped payloads, so field renames still propagate, and the type system stops describing what the UI actually renders. |
| **Re-emit SDK events unchanged and normalize inside the webview** | Keeps `core` thin; UI shapes data exactly as it renders it. | Puts SDK knowledge in the least privileged, least testable package, duplicates normalization for any non-UI consumer (checkpoints, session log, orchestration), and violates the UI/business-logic separation of **C5** and [ADR 0003](0003-core-host-webview-split.md). |
| **Pin the SDK version and never upgrade** | Zero churn, fully deterministic behaviour. | Forfeits fixes, model updates, and new tools on a dependency that is actively maturing, and merely defers an eventually forced, much larger migration. |
| **Full provider-neutral abstraction designed for N providers up front** | Maximum future flexibility; a second provider would drop in. | Speculative generality against a requirement §10 explicitly disclaims for v1. The union is deliberately shaped by what TARS's UI and orchestration need, not by a hypothetical intersection of unknown providers. |

## Consequences

### Positive
- An SDK upgrade has a blast radius of one file. That is the single largest risk reduction in the architecture, and it is the reason [ADR 0001](0001-claude-agent-sdk-as-integration-layer.md) is safe to make.
- The union is a closed discriminated union, so exhaustive switches in orchestration, IPC handling, and the store are compiler-checked; an added member produces errors at every site that must handle it.
- `ClaudeCodeProvider` is testable against a fake SDK stream in plain Node, with no editor and no network (§8.1).
- The event set is shaped by what the UI must render, so no component derives UI state by inferring stream structure.
- `permission_request` makes gating a first-class event, giving safety the same plumbing as streaming text.
- Capability flags let the UI degrade by declaration, not by provider name.

### Negative
- Every SDK stream capability must be explicitly mapped before it is usable. Features the union does not name are invisible to the rest of the system, so adopting a new SDK capability requires a deliberate union change.
- Mapping code is real code and can be wrong. A defect in the adapter presents as an inexplicable UI bug far from its cause, which is why adapter tests against a fake stream are mandatory rather than optional.
- Two representations of the same conversation exist — the SDK's and TARS's — and must be kept semantically aligned.

### Neutral / accepted costs
- The abstraction is built in phase 1 with exactly one provider behind it. This is bought as insulation against a pre-1.0 dependency, not as extensibility; the multi-provider capability is a side effect.
- Block boundaries are explicit, not inferred: `turn_start`/`turn_end` and `thinking_start`/`thinking_end` are matched pairs. Inferring closure from "an event of a different type arrived" was considered and rejected — Claude interleaves thinking with tool calls, so a `tool_call_start` does not mean the thinking block ended, since thinking may resume. Under an inference rule a collapsed thinking panel either never closes or closes too early. Two extra members remove that class of bug.
- The union still has no `text_start`. Unlike thinking, assistant prose has no interleaving ambiguity: it is delimited by the first `text_delta` after `turn_start` and closed by `turn_end`. A terminator here would be ceremony, so the asymmetry with thinking is deliberate rather than an oversight.
- Adding a union member is a breaking change for every exhaustive switch. That friction is the point.

## Revisit If
- An SDK minor release forces changes outside `ClaudeCodeProvider` twice in a row. The seam would then be in the wrong place, and the union — not the SDK choice — needs redesign.
- Adapter defects become the top source of user-visible bugs across phases 2–3, indicating the mapping is too complex and should be narrowed.
- A second provider is genuinely adopted, at which point the union must be re-derived from two real streams rather than one, and members that turn out to be Claude-specific must be moved behind `ProviderCapabilities`.
- Consumers are found reconstructing text-block boundaries inconsistently in the absence of a `text_start` terminator; it should then be added for symmetry with thinking, and every exhaustive switch updated.
- The SDK reaches 1.0 with a stability guarantee. The seam still earns its keep for UI shaping and testability, but the insulation argument weakens, and the union may be simplified toward the SDK's own shape.
