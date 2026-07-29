# ADR 0002 — Custom webview instead of `vscode.lm` / Chat Participant API

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §1.1 (C1, C2), §5, §8.4

## Context

VS Code ships first-party surfaces for exactly the kind of product TARS is: the **Language Model API** (`vscode.lm`) for model access and the **Chat Participant API** for registering a conversational agent into the editor's own chat panel. Using them would be the obvious path. A participant inherits the editor's chat UI, its keyboard model, its accessibility work, its theming, and its variable/`@`-mention plumbing — a large amount of interaction design TARS would otherwise have to build.

Constraint **C1** removes that path. TARS must run in **Cursor and VSCodium**, not only in Microsoft's VS Code build. Both `vscode.lm` and the Chat Participant API are Copilot-gated and fork-unstable: model access is mediated by an entitlement TARS's users may not have, and the forks either replace the chat surface with their own, ship it partially, or omit it. A feature that is present in one editor, degraded in the second, and absent in the third is not a foundation — it is three products.

Constraint **C2** closes the escape hatches. TARS never uses Cursor private APIs and never patches or reverse-engineers the editor. Only documented, stable `vscode` extension APIs are permitted; proposed APIs are allowed solely behind a capability check with a graceful fallback, and in practice not at all — proposed APIs require an `enabledApiProposals` flag the marketplace does not permit and forks do not reliably ship (§8.4).

The two constraints together settle the matter, and they settle it cleanly rather than as a compromise. The model does not need to come from the editor: it arrives through the Claude Agent SDK ([ADR 0001](0001-claude-agent-sdk-as-integration-layer.md)), which TARS hosts itself and which is identical in every fork. What remains is the UI, and a webview is the one rendering surface every VS Code-compatible editor supports on documented, stable API.

## Decision

TARS renders its entire conversational UI in a **custom webview** that it owns, registered in the Activity Bar, and reaches the model through the Claude Agent SDK. TARS uses neither `vscode.lm` nor the Chat Participant API, and registers no chat participant.

The webview is a pure renderer. It never touches `vscode`, the filesystem, or the SDK; it renders state and emits intents across a typed IPC contract owned by `shared/` (§5.1). All privilege lives in `host`. The webview runs under a strict CSP — nonce'd inline scripts, no `unsafe-eval`, no external origins, all assets bundled and served from the extension's own URI — and loads nothing from the network (§5.4).

`engines.vscode` is pinned to `^1.90.0`, below the oldest supported fork rather than at the newest upstream release. Any API newer than that baseline is feature-detected with a graceful fallback, never assumed present. No proposed API is used.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Chat Participant API** | Inherits the editor's native chat panel: accessibility, keyboard model, theming, history, variable and file-reference plumbing, and a UI users already know. Substantially less code than a bespoke shell. | Violates **C1**. Copilot-gated and fork-unstable — absent or partial in Cursor and VSCodium. The core interaction surface of the product cannot be conditionally available. |
| **`vscode.lm` for model access** | Model calls, quota, and credentials handled by the editor. No API key handling and no SDK dependency. | Violates **C1** on availability, and is architecturally wrong for TARS regardless: it provides model *completions*, not an agent loop with tools, permissions, subagents, and compaction — which is precisely what [ADR 0001](0001-claude-agent-sdk-as-integration-layer.md) selects the Agent SDK to supply. |
| **Native surfaces where available, webview as fallback** | Best-in-class UI on stock VS Code without abandoning fork support. | Two independent front ends, two interaction models, two test matrices, and a product whose behaviour differs by editor. Cost is roughly doubled to make the *least* constrained environment marginally nicer. |
| **Proposed / private APIs behind capability checks** | Would unlock the native chat surface today. | Violates **C2**, and is not shippable: proposed APIs require `enabledApiProposals`, which the marketplace does not permit and forks do not reliably ship. Cursor private APIs are undocumented and break without notice. |
| **Tree view and quick-pick UI only** | Fully native widgets, no webview, no CSP surface, trivially theme-correct. | Cannot express token streaming, a tool timeline, inline thinking, or per-hunk review affordances. The interaction model TARS needs is not a list. |

## Consequences

### Positive
- One UI, identical behaviour, in VS Code, Cursor, VSCodium, and compatible forks. One test matrix.
- No Copilot entitlement, no gated API, and no dependency on a fork tracking upstream chat features.
- Full control over the interaction surface: streaming, thinking blocks, tool timeline, permission prompts, and review affordances are designed for the agent loop rather than fitted to someone else's chat widget.
- Theme fidelity is retained without native widgets: VS Code exposes theme colours as `var(--vscode-*)` custom properties, mapped onto Tailwind tokens, so TARS inherits the user's theme — including fork themes — with no per-theme code (§5.3, [ADR 0005](0005-react-vite-tailwind-webview.md)).
- A strict CSP and a zero-privilege webview make the UI a small, auditable attack surface.

### Negative
- Accessibility, keyboard navigation, focus management, and screen-reader behaviour are TARS's responsibility. `webview-ui` therefore carries explicit accessibility tests (§8.1).
- The chat UI must be built and maintained rather than inherited — the substantive cost of phase 2.
- The webview does not participate in editor-native chat affordances: no `@`-workspace variables from the host chat, no chat history integration, no chat-panel keybindings. TARS implements its own `@`-mentions (§7.2) and commands.
- IPC is a real boundary with real serialization costs, and every UI-visible piece of state must cross it.

### Neutral / accepted costs
- A pinned `^1.90.0` floor means TARS forgoes newer VS Code APIs unless they are feature-detected. Raising the floor is a deliberate, ADR-worthy decision, never a side effect of a dependency bump (§8.4).
- Dark mode is the design baseline; light themes are supported through the same token mapping rather than designed first.
- Because the webview holds no privilege, every action it needs — reading a file, opening a diff, running a terminal command — is an intent message serviced by `host`.

## Revisit If
- Both Cursor and VSCodium ship the Chat Participant API on stable, documented, non-Copilot-gated terms, and hold it across two consecutive releases each. That would remove the **C1** objection and make a native participant worth costing as an *additional* surface.
- TARS's supported-editor list narrows to Microsoft VS Code only, dissolving the constraint that produced this decision.
- Accessibility defects in the custom webview persist past phase 6 despite the `webview-ui` accessibility suite, indicating the inherited-UI argument outweighs the portability argument.
- VS Code makes `vscode.lm` ungated *and* extends it to a full tool-using agent loop with permission hooks, at which point [ADR 0001](0001-claude-agent-sdk-as-integration-layer.md) and this ADR must be re-evaluated together.
