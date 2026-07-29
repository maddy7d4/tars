# ADR 0005 — React 19 + Vite + Tailwind v4 for the webview

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §3, §5.2, §5.3, §5.4, §8.1, §8.2

## Context

[ADR 0002](0002-custom-webview-not-vscode-lm.md) commits TARS to owning its entire conversational UI in a custom webview. That makes the front-end stack a real decision rather than an inherited default, and it must be made against a specific and demanding workload rather than general preference.

The workload is token streaming. `text_delta` events arrive continuously during a turn and append into conversation state; a long session accumulates hundreds of messages, each with nested tool timeline entries, thinking blocks, permission prompts, and proposed edits. The failure mode is not correctness but paint time: naive state management re-renders the whole conversation on every delta, and the UI degrades exactly when the user is watching it most closely. Whatever stack is chosen must make targeted subscription and list virtualization straightforward, not heroic.

The second requirement is theme fidelity. TARS must look native in VS Code, Cursor, and VSCodium, under any user theme, with no per-theme code. VS Code exposes theme colours to webviews as CSS custom properties (`var(--vscode-*)`), so the styling system must be able to consume runtime CSS variables as first-class design tokens — not just compile-time values.

The third is the CSP in §5.4: nonce'd inline scripts, no `unsafe-eval`, no external origins, all assets bundled and served from the extension's own URI, nothing loaded from the network. This rules out any stack that depends on runtime evaluation or CDN-delivered assets, and it means the build must emit a fully self-contained bundle with hashed asset names that the host can reference and nonce correctly.

Finally, [ADR 0003](0003-core-host-webview-split.md) makes `webview-ui` a package that depends only on `shared`. It has no access to `vscode`, the filesystem, or the SDK. Its build is therefore fully independent of the extension bundle, which frees it to use a different bundler from `host` and `extension`.

## Decision

`webview-ui` is built with **React 19**, bundled by **Vite**, and styled with **Tailwind CSS v4**. State is held in a **Zustand** store.

Streaming `text_delta` events append into the Zustand store, and the message list is **virtualized** so that a long conversation does not degrade paint time.

Theming maps VS Code's `var(--vscode-*)` custom properties onto Tailwind theme tokens, so TARS inherits the user's theme — including Cursor and VSCodium themes — with no per-theme code. **Dark mode is the design baseline.**

Vite is used because it provides HMR in development and hashed assets in production. It is deliberately a *different* bundler from the extension side: `extension` and `host` build with esbuild, which produces the single CommonJS bundle VS Code expects (§8.2). The `.vsix` is assembled by `@vscode/vsce` from built output only.

`webview-ui` is tested with **Vitest + React Testing Library**, covering component behaviour, accessibility, and streaming render (§8.1). Accessibility is an explicit test target because [ADR 0002](0002-custom-webview-not-vscode-lm.md) makes it TARS's responsibility rather than the editor's.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Redux (or Redux Toolkit) for state** | Mature, excellent devtools and time-travel debugging, and a rigorous, auditable pattern for a store that will grow to hold conversations, tool timelines, change sets, and permission queues. | Boilerplate. Actions, reducers, and selectors for every UI concern is a large, permanent tax for a single-webview store, and the concurrency and middleware machinery solves problems this UI does not have. |
| **Raw React Context for state** | Zero dependencies, idiomatic React, trivially understood. | Re-render storms under token streaming. Context propagates to every consumer on every change, which is precisely the wrong behaviour for high-frequency `text_delta` appends. This is the failure mode the workload guarantees. |
| **Svelte or Solid** | Finer-grained reactivity than React's, better suited to high-frequency streaming updates, and smaller bundles. Genuinely a good technical fit for the workload. | Ecosystem depth for the specific components TARS needs — virtualized lists, accessible primitives, testing tooling — is thinner, and the team's leverage is in React. The paint-time problem is solved by virtualization plus targeted store subscriptions, so the reactivity advantage does not decide the case. |
| **No framework — plain TypeScript and DOM** | Smallest possible bundle, no framework churn, complete control over update batching. | The UI is genuinely stateful: streaming text, nested tool timelines, permission queues, plan updates, and per-hunk review affordances. Hand-rolled DOM diffing for that is a framework, written worse. |
| **esbuild for `webview-ui` too, for a single bundler** | One toolchain to configure, understand, and keep current across all packages. | Loses HMR, which is the dominant productivity factor for UI work, and loses Vite's production asset hashing and CSS pipeline. The two build targets have genuinely different needs; using two tools is the smaller cost. |
| **Plain CSS or CSS Modules instead of Tailwind** | No build-time styling dependency, no utility-class churn, and direct use of `var(--vscode-*)` with nothing in between. | Tailwind v4's theme-token model maps runtime CSS custom properties into design tokens cleanly, which is exactly the §5.3 requirement, and it gives one consistent spacing and typography scale across a UI several people will extend over phases 2–6. |
| **A VS Code webview UI toolkit component library** | Components styled to match the editor out of the box, less theming work. | Adds a dependency whose fidelity across Cursor and VSCodium is not guaranteed, and the `var(--vscode-*)` token mapping already delivers theme inheritance with no per-theme code and no third-party surface. |

## Consequences

### Positive
- Streaming stays smooth: Zustand's targeted subscriptions plus list virtualization keep `text_delta` appends from re-rendering the conversation.
- Theme fidelity across VS Code, Cursor, and VSCodium with no per-theme code, because tokens resolve at runtime from the editor's own custom properties.
- HMR makes phase 2's UI work fast, and hashed production assets keep the `.vsix` cacheable and self-contained.
- React Testing Library gives behaviour-level and accessibility-level tests in plain Node under Vitest, with no editor harness.
- React 19's ecosystem supplies mature virtualization and accessible primitives.
- The webview bundle is fully self-contained, satisfying the strict CSP with no external origins and no `unsafe-eval`.

### Negative
- Two bundlers in one repository — esbuild for `extension`/`host`, Vite for `webview-ui` — means two configurations to maintain and two upgrade paths.
- Tailwind v4 and React 19 are recent majors; their ecosystems move, and upgrades will need attention.
- React's re-render model requires ongoing discipline: memoization boundaries and store selector granularity are things reviewers must actively check, because the compiler will not.
- Virtualization complicates otherwise simple UI behaviour — find-in-page, scroll restoration, and "jump to message" all need explicit handling.

### Neutral / accepted costs
- Zustand is an additional dependency where Context is built in. Accepted deliberately: the re-render characteristics decide it.
- Dark mode is the design baseline, so light themes are validated through the token mapping rather than designed first.
- The webview holds zero privilege ([ADR 0003](0003-core-host-webview-split.md), §5.1), so every action it needs is an intent message to `host`. All rich interaction is therefore asynchronous by construction.
- Any asset the UI needs must be bundled; no font, icon, or image may be fetched at runtime.

## Revisit If
- Streaming render measurably misses phase 6's performance budgets after virtualization and selector-level optimization are in place. That would indicate React's reactivity model is the binding constraint and a finer-grained framework should be costed.
- The Zustand store grows enough structure — cross-slice invariants across conversations, change sets, checkpoints, and permission queues — that ad hoc selectors stop being auditable, at which point a more prescriptive state pattern becomes worth its boilerplate.
- The `var(--vscode-*)` token mapping fails to produce a native appearance in a supported fork, requiring per-editor styling and reopening the component-library question.
- Maintaining two bundlers produces recurring build divergence, or esbuild gains an HMR and asset story sufficient to consolidate on one toolchain.
- Tailwind v4 or React 19 reaches end of support, forcing a scheduled major migration.
