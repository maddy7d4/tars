# ADR 0001 — Claude Agent SDK as the integration layer

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §1.2, §1.3, §4

## Context

TARS is an AI engineering platform shipped as a `.vsix` VS Code extension. Its central technical question is not *which model* — that is settled, Claude — but *at which layer* the agent loop is integrated. Three integration layers exist for Claude, and they differ in what they host, not merely in ergonomics: Anthropic **Managed Agents** (Anthropic hosts both the loop and a per-session container), the **Messages API with a tool runner** (the caller hosts everything), and the **Claude Agent SDK**, `@anthropic-ai/claude-agent-sdk` — Claude Code packaged as a library, harness-only, hosted by the embedding application.

Two hard constraints from spec §1.1 eliminate two of the three before preference enters the discussion. **C3** states that the workspace lives on the user's disk; tool execution must therefore be local. Managed Agents run the loop and its filesystem in a remote container, so the agent would be reading and writing files that are not the user's files. That is not a latency problem that could be engineered away — it is a wrong-machine problem. Managed Agents are out.

**C4** carries the project rule from [`claude.md`](../../claude.md): "reuse SDK capabilities instead of reimplementing them." Building on the raw Messages API means writing, owning, and debugging an agent loop, context compaction, a permission model, subagent dispatch, session resume, and a tool suite (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`) — every one of which the Agent SDK already ships, tested, as the same machinery that runs Claude Code itself. Reimplementing that is months of work whose best possible outcome is parity with a dependency we could have installed.

The residual concern is version risk. The SDK is pre-1.0 (`0.3.x`) and will introduce breaking changes. This is a real cost, and it is the reason the provider abstraction of §4 exists — see [ADR 0004](0004-normalized-agent-event-union.md). The abstraction is load-bearing insulation against a known-moving dependency, not speculative generality.

Authentication reinforces the choice. The SDK resolves credentials through the standard Anthropic precedence chain: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → the OAuth profile on disk from an existing `claude` login. Every developer who already uses Claude Code gets zero-config auth, and TARS builds no login flow at all.

## Decision

TARS integrates Claude through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), hosted inside the VS Code extension host. The SDK owns the agent loop, context management, hooks, subagents, permissions, sessions, and the built-in tool suite. TARS owns the harness: editor integration, UI, review workflow, context curation, and persistence.

Authentication is delegated entirely to the SDK's credential precedence chain. TARS ships no login flow. It offers one optional override — an explicit key stored through `SecretsPort` in the OS keychain — and never writes an API key to `settings.json`, which users commit.

Exactly one module, `ClaudeCodeProvider`, may import `@anthropic-ai/claude-agent-sdk`. That containment is specified in [ADR 0004](0004-normalized-agent-event-union.md) and enforced with the same mechanism as the package boundary rule in [ADR 0003](0003-core-host-webview-split.md).

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Anthropic Managed Agents** | Anthropic hosts the loop *and* a sandboxed per-session container. Zero agent-loop code, zero local execution risk, server-side upgrades, and the strongest available blast-radius containment for `Bash`. | Violates **C3**. The workspace is on the user's disk. A remote container cannot read, edit, or run the user's actual repository, and syncing a working tree into a remote sandbox is a distributed-state problem larger than the one being solved. |
| **Messages API + own tool runner** | Maximum control. No pre-1.0 dependency, no upstream API churn, and full freedom over loop shape, prompt construction, compaction policy, and tool surface. Provider-neutral from day one. | Violates **C4**. Requires reimplementing the agent loop, context compaction, permission gating, subagents, session resume, and eight tools — all of which the SDK ships. The realistic best case is parity, months later, with more defects. |
| **Claude Code CLI as a subprocess, parsed as text** | Extremely cheap to prototype. Reuses the entire Claude Code harness with no library integration at all. | The interface is a terminal UI, not a contract. Parsing rendered output is brittle, and structured needs — `canUseTool` gating, per-tool arguments, token usage, interrupt — are either unavailable or recovered by scraping. The SDK exposes the same engine through a typed API. |
| **Wait for SDK 1.0 before committing** | Avoids absorbing breaking changes during the pre-1.0 window. | Blocks the entire programme on an external release date TARS does not control. The provider seam (§4) reduces the cost of a breaking change to one adapter file, which makes the wait unnecessary. |

## Consequences

### Positive
- The agent loop, context compaction, subagents, hooks, permissions, and eight production tools arrive as a dependency. Phase 1 delivers a working agent rather than an agent framework.
- Zero-config authentication for the large population of developers with an existing `claude` login.
- Tool execution is local, satisfying **C3** and keeping the user's repository the single source of truth.
- `canUseTool` gives permission gating a first-class hook, so safety and autonomy share one mechanism (§4.2) instead of safety being retrofitted.
- SDK improvements — better compaction, new tools, model updates — arrive as version bumps.

### Negative
- A hard dependency on a pre-1.0 package. Breaking changes are expected, not hypothetical.
- The loop is a black box. Prompt construction and compaction policy are the SDK's decisions, and diagnosing an unexpected agent behaviour means reasoning about code TARS does not own.
- The SDK runs inside the extension host process, so its resource usage counts against the editor's.

### Neutral / accepted costs
- The provider abstraction and normalized event union ([ADR 0004](0004-normalized-agent-event-union.md)) must be built in phase 1, before any second provider exists to justify them. This is deliberate: the abstraction is bought as insurance against the pre-1.0 dependency, not as extensibility.
- v1 ships exactly one provider (§10). The abstraction admits others; nothing plans to add them.
- Credential resolution behaviour is inherited from the SDK, so its precedence chain — not TARS — is what users must reason about when auth misbehaves.

## Revisit If
- The SDK's licence, distribution terms, or bundling rules change such that redistribution inside a marketplace `.vsix` is no longer permitted.
- Two consecutive minor SDK releases each require changes outside `ClaudeCodeProvider`. That would falsify the containment premise and mean the seam is in the wrong place, not that the SDK is wrong.
- The SDK cannot be made to run in the VS Code extension host on a platform TARS supports — for example a Node version or bundling constraint that esbuild cannot resolve into a single CommonJS bundle (§8.2).
- Anthropic ships a Managed Agents mode that executes tools against a local workspace over a documented protocol, which would remove the **C3** objection and re-open the hosting question.
- A measured requirement appears for provider-level control the SDK does not expose — custom compaction, custom loop termination, or a tool the SDK cannot register — and that requirement blocks a shipping feature rather than merely a desired one.
