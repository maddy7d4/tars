# ADR 0003 — Core/host/webview split with a CI-enforced dependency rule

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §3, §3.1, §3.2, §8.1, §8.3

## Context

TARS spans roughly twenty-five components: agent orchestration, a provider registry, a diff engine, a context engine, workspace memory, checkpoints, a planner, terminal and Git integration, MCP configuration, and a streaming React UI. Constraint **C5** carries the [`claude.md`](../../claude.md) rules that make the shape of that codebase non-negotiable — strong typing, no `any`, modular packages, UI separate from business logic, no monolith — and adds the decisive clause: enforced mechanically in CI, not by convention.

The dominant technical risk is not complexity but *testability*. Anything that imports `vscode` can only be executed inside an Electron test harness (`@vscode/test-electron`): slow to start, awkward to debug, and flaky under concurrency. If the diff engine, the indexer, the checkpoint store, and the orchestrator each import `vscode` — even incidentally, for a `Uri` type or a `workspace.fs` call — then the entire business logic of phases 3 through 5 is reachable only through that harness. Phase 3's per-hunk apply/reject logic and phase 4's incremental index are exactly the subsystems that need hundreds of fast, deterministic test cases, and they are precisely the ones that a careless import makes untestable.

The inverse also holds and is cheap: if `core` contains no `vscode` import at all, every one of those subsystems runs in plain Node under Vitest. Coverage then concentrates where the logic lives, and `host` stays thin enough that little of it requires the slow harness at all.

Boundaries maintained by convention erode. The erosion is never a decision — it is one import added under deadline pressure to fix one thing, and by the time anyone notices, `core` no longer builds without the editor. The only durable version of this rule is one the build refuses to violate.

## Decision

TARS is a pnpm workspace monorepo (**C6**, corepack-pinned) with five packages and a strictly one-way dependency graph:

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

```
extension → host → core → shared
webview-ui → shared
```

Nothing flows back. `core` importing `vscode`, `host`, or `webview-ui` is a **CI failure**, enforced by an ESLint `no-restricted-imports` rule that runs in the lint step of every push and pull request (§8.3). A red boundary rule is a red build.

`core` declares ports as interfaces; `host` supplies the real implementations; tests supply fakes:

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

`extension` is the composition root and the only place where concrete implementations meet interfaces.

Two ports deserve explicit justification because both look like over-abstraction and neither is. `ClockPort` exists because everything timestamped — checkpoints, session log records, any future telemetry — is untestable against a real clock and produces flaky ordering assertions; injecting time costs nothing now and is painful to retrofit once phase 3's checkpoint records exist. `SecretsPort` is a security boundary, not plumbing: it keeps credentials in the OS keychain instead of in committed configuration.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Single extension package** | Simplest possible build, no workspace wiring, no port indirection, no cross-package type friction. Fastest to phase 2. | Violates **C5** ("no monolith") and destroys the testability property: `vscode` imports spread freely, and phases 3–5 become reachable only through `@vscode/test-electron`. The monolith is cheapest exactly until the phase where most of the logic gets written. |
| **Layered folders inside one package** | Most of the conceptual separation with none of the workspace overhead. Refactors across layers stay trivial. | The boundary is unenforceable. `no-restricted-imports` can restrict paths, but a folder is not a dependency graph — one relative import defeats it, and nothing at publish or build time objects. |
| **Convention-only rule, documented not enforced** | Zero tooling cost, full developer flexibility for genuine exceptions. | The failure mode is well understood: boundaries not enforced by the build erode under deadline pressure. **C5** explicitly requires mechanical enforcement. |
| **Allow `core` to import `vscode` types only (`import type`)** | Type-only imports are erased at compile time, so no runtime dependency on the editor is introduced — `Uri`, `Range`, and `Diagnostic` could be used directly, removing a lot of mapping code. | Rejected as an unpoliceable line. Distinguishing type-only from value imports in review is exactly the judgement call that erodes, and `core`'s public types would then be shaped by the editor's, defeating the sidecar option and coupling `core`'s test fixtures to `vscode` type constructors. Ports define their own types. |
| **Sidecar daemon for `core` from day one** | Complete process isolation, crash containment, and `core` restartable independently of the extension host. | Unjustified cost in v1: IPC, lifecycle, and a second process to install and debug, for a benefit no requirement demands. This decision *preserves* the option — lifting `core` into a sidecar later is a pure transport change touching zero business logic. |

## Consequences

### Positive
- Agent orchestration, provider adapters (against a fake SDK), the diff engine, checkpoints, and the index are unit-testable in plain Node under Vitest. Fast, deterministic, and the bulk of coverage (§8.1).
- Phases 3–5 become tractable. Their subsystems would otherwise be reachable only through slow, flaky integration tests.
- `host` stays thin by design, so little logic requires `@vscode/test-electron`.
- Ports give every external dependency a fake, so tests need neither a real filesystem, a real clock, a real keychain, nor a real repository.
- The option to lift `core` into a sidecar daemon later survives as a transport change, not a rewrite (§10).
- UI/business-logic separation is structural: `webview-ui` depends only on `shared` and can never reach `core` or `host`.

### Negative
- Five packages to configure, build, version, and keep type-consistent. Real setup cost in phase 0.
- Every editor capability `core` needs must first be expressed as a port, with a real implementation and a fake. That is friction on each new integration, felt most in phase 5.
- `core` cannot use `vscode`'s convenient types, so `Uri`-like and `Range`-like values need port-owned equivalents and mapping at the `host` boundary.
- Cross-package refactors touch more files than the same change in a single package.

### Neutral / accepted costs
- Nine ports exist before phase 5 needs all of them. `TerminalPort` and `GitPort` are declared early so the boundary is complete rather than discovered piecemeal.
- The ESLint boundary rule is a build gate, so a legitimate exception cannot be waived quietly — it requires changing the rule, in a reviewed commit. That is the intended cost.
- pnpm and corepack are mandatory (**C6**); other package managers are unsupported.

## Revisit If
- The ESLint `no-restricted-imports` rule proves circumventable in practice — a `vscode` symbol reaches `core` through a transitive dependency, a dynamic `require`, or a path alias — and CI does not catch it. The rule must then be strengthened (for example with a dependency-graph check in the build step), not relaxed.
- The extension host process becomes a measured bottleneck against phase 6's performance budgets, making the sidecar option worth exercising.
- A port accumulates real logic instead of adapting an editor API, meaning behaviour has leaked from `core` into `host`; the port's shape is then wrong and needs redesign.
- Package count grows beyond these five without a boundary argument as strong as the `vscode` one. Splitting for tidiness rather than for enforcement is a regression against this decision.
