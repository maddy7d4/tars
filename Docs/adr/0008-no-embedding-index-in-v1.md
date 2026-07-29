# ADR 0008 — No embedding index in v1

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §7, §7.1, §7.2, §10

## Context

Semantic code search over an embedding index is the expected feature of an AI coding tool, and its absence is the kind of gap a competitor's feature list makes conspicuous. It therefore needs an explicit decision and an explicit rationale, recorded so it is not re-litigated on each retelling.

The starting point is what TARS already has. The Claude Agent SDK ships `Glob`, `Grep`, `Read`, and `WebFetch`, and Claude uses them competently — issuing targeted searches, reading results, and refining queries in a loop. On top of that, phase 4 adds an incremental file index respecting `.gitignore` and backed by a file watcher, `ripgrep` text search (which ships with VS Code, so no binary is bundled), and symbol navigation through `vscode.executeWorkspaceSymbolProvider`. That last item is worth dwelling on: it reuses whatever language servers the user already has installed, so TARS gets accurate, semantically real symbols for every language the user's editor supports, for free, rather than shipping parsers for N languages.

Against that baseline, what an embedding index adds is a full pipeline: chunking, an embedding model dependency, a vector store on disk, and — the hard part — incremental invalidation as the working tree changes on every keystroke, branch switch, and rebase. It also adds disk growth proportional to repository size and a re-index cost on first open of a large repository. The genuine capability it buys is retrieval by meaning where the user does not know the identifier — "where do we handle retry backoff" when nothing is named `retry` or `backoff`.

That capability is real but narrow, and it is narrowest precisely in TARS's target case: a single repository, where grep plus symbol lookup plus an agent that can iterate its own queries covers most of the ground. The gains the pipeline would deliver are largely already delivered by the SDK's own search.

The governing principle in §7.1 settles it. TARS's value is **curation** — deciding what enters context and letting the user steer it — not rebuilding retrieval. The `@`-mention system that resolves files, symbols, diagnostics, selections, and terminal output into typed context items attached to a turn is the differentiating investment. An embedding index is retrieval infrastructure competing for the same phase 4 budget.

## Decision

**v1 ships no embedding index and no vector store.** Context retrieval in v1 is composed from:

| Component | Mechanism |
|---|---|
| Agent-driven search | The SDK's own `Glob`, `Grep`, `Read`, `WebFetch` |
| File index | Incremental walk respecting `.gitignore`, backed by a file watcher; powers `@`-mention completion and fast path resolution |
| Text search | `ripgrep`, which ships with VS Code — no bundled binary |
| Symbol navigation | `vscode.executeWorkspaceSymbolProvider`, reusing the user's installed language servers |
| `@`-mentions | Resolve files, symbols, diagnostics, selections, and terminal output into typed context items attached to a turn |

Embedding and vector retrieval are recorded as an explicit **non-goal for v1.0** (§10), deferred until measurement justifies it — not until it is requested.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **Local embedding index with a bundled model** | Semantic retrieval with no network dependency and no per-query cost, working offline and on private code. The strongest privacy story for embeddings. | Bundles a model into the `.vsix` (size, licence, platform-specific runtime), spends CPU on indexing inside the extension host, and grows disk proportionally to repository size — for gains the SDK's own search largely already delivers on a single repository. |
| **Remote embedding API** | No bundled model, best available embedding quality, and no local CPU cost. | Sends repository content to a network service for indexing, which is a materially larger data-egress surface than sending only what a turn actually needs. It also adds per-index cost and an availability dependency for a core retrieval path. |
| **Hybrid — grep first, embeddings for fallback queries** | Cheap in the common case, semantic coverage in the tail, and the tail is exactly where grep fails. Genuinely the best long-term design. | Still requires the entire pipeline (chunking, model, store, invalidation) to serve the fallback path, so nearly all the cost is incurred for a fraction of the queries. It is the right *next* step once measurement identifies which queries actually fail, and it is deliberately sequenced after that measurement, not before. |
| **Ship a lightweight lexical index (BM25 or similar) instead** | Better ranking than raw grep, no model dependency, and modest disk cost. | Duplicates `ripgrep`, which already ships with the editor, and duplicates the SDK's search behaviour. Adds an index to invalidate for a ranking improvement no measurement has requested. |
| **Ship embeddings in v1 anyway, for competitive parity** | Removes a conspicuous gap from the feature list. | Optimizes for a comparison table rather than for retrieval quality, and spends phase 4's budget on infrastructure instead of on the `@`-mention curation layer that is actually differentiating. |

## Consequences

### Positive
- No embedding pipeline to build, no model dependency to bundle or licence, no vector store to invalidate, and no re-index cost on first open of a large repository.
- No repository content is embedded or sent anywhere for indexing. The data-egress surface stays limited to what a turn requires.
- `ripgrep` and the user's language servers are reused, so TARS gets accurate symbols across every language the editor supports without shipping parsers.
- Disk usage stays bounded and proportional to the file index rather than to repository content.
- Phase 4's budget goes to `@`-mention curation — files, symbols, diagnostics, selections, terminal output as typed context items — which is where the differentiated value is.
- Retrieval quality tracks the SDK's improvements automatically instead of being frozen at TARS's own implementation.

### Negative
- No retrieval by meaning. A query whose relevant code shares no identifier or literal with the query terms will be found only if the agent's iterative grep strategy stumbles onto it.
- Discovery in an unfamiliar codebase is weaker than with semantic search, which is the case where a newcomer would benefit most.
- Retrieval quality is partly outside TARS's control, being a function of how the SDK drives its own search tools.
- The absence is visible in feature comparisons against tools that ship semantic search.

### Neutral / accepted costs
- The file index and watcher are still built, so incremental workspace tracking exists in v1 — an embedding index would be an addition to that layer, not a replacement for it.
- Symbol quality depends on the user's installed language servers, so a language with no extension installed yields no symbols. Accepted: reusing the user's toolchain is worth more than shipping parsers for N languages.
- Deferral is genuine, not permanent. The architecture admits an index behind the context engine's existing composition without redesign.

## Revisit If
- Measurement — not intuition — shows a material share of real user turns failing to locate relevant code that a semantic index would have found. This is the primary trigger, and it requires instrumentation of retrieval outcomes, which itself requires the opt-in telemetry decision recorded as a non-goal in §10.
- Users report codebase-discovery failures (as opposed to specific search misses) as a recurring complaint through phases 4–6.
- TARS's supported scope widens from a single repository to multi-repository or monorepo-of-monorepos scale, where grep's cost grows and lexical matching thins out.
- An embedding model becomes available that can be bundled or hosted without meaningful `.vsix` size cost, indexing CPU cost, or new data egress, materially changing the cost side of the trade.
- The SDK's built-in search regresses or is deprecated, removing the baseline this decision leans on.
