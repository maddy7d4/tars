# Performance budgets

Written as part of phase 6. Every number below was measured, not estimated; the
measurement is named beside it. Budgets that CI enforces are marked **enforced**.

## Principle

Budget only what TARS controls, and set ceilings with real headroom. A budget set
at the current high-water mark fails on the next honest change and trains
everyone to raise it without reading it, which is worse than having none.

The extension bundle is therefore **not** budgeted: at 5.0 MB it is dominated by
the Agent SDK, whose size TARS does not choose. Budgeting it would turn an
upstream release into a red build that says nothing about this code.

## Artefact size — **enforced**

Checked by `pnpm budgets`, which runs in `verify` and CI after the build.

| Artefact | Measured | Budget | Why this ceiling |
|---|---|---|---|
| `webview main.js` | 213 KB | 400 KB | The panel is React plus a transcript reducer. Approaching this means a dependency arrived that belonged in the host. |
| `webview main.css` | 11 KB | 64 KB | Tailwind emits only what the components use; growth means unused utilities are being retained. |
| `.vsix` | 1.27 MB, 11 files | — | Reported rather than budgeted, for the same reason as the bundle. The *file count* is the meaningful check, and `.vscodeignore` enforces it by excluding everything and adding back only `dist/`. |

## Latency

These are design constraints rather than CI assertions: measuring them
faithfully needs a real editor and a real workspace, and a threshold that flaked
on a loaded CI runner would be turned off within a week.

| Path | Constraint | How it is met |
|---|---|---|
| Streamed token → paint | No I/O on the path | The session log batches appends and drains on the next microtask; a file write per `text_delta` is explicitly ruled out (§4.3). A token append is one string concatenation and one slot assignment — the transcript array is mutated in place, so a long conversation stays O(1) per token rather than O(n). |
| Transcript repaint | One row, not the list | Items are immutable and memoized on identity, so a token replaces exactly one item and only that row repaints. The store publishes a `revision` counter because the array's identity can no longer signal change. |
| `@`-mention completion | Never blocks on a language server | Symbols are requested concurrently with the file search and abandoned after 250 ms. Showing files now beats showing everything later. |
| Activation | No workspace walk | The file index defers its initial walk to first use, so a window whose panel is never opened does not pay for it. The agent session is created lazily on the first prompt, so no keychain read or subprocess spawn happens at activation. |
| File index update | O(1) per change | Creations and deletions apply incrementally. A full rebuild happens only when a `.gitignore` changes, debounced 500 ms — a branch switch rewrites it alongside everything else, and a walk per event would turn a checkout into a stall. |
| Diff computation | Proportional to the edit | Greedy Myers is O(n·d) in the number of differences, and common affixes are stripped first so `d` tracks the change rather than the file. Above 20 000 lines per side it degrades to an honest whole-file replacement rather than stalling the extension host. |

## Bounded state

Unbounded growth is a performance bug that only appears after months of use, so
every store has a ceiling:

| Store | Bound | On overflow |
|---|---|---|
| File index | 50 000 files, depth 32 | Reports `isTruncated` so callers can warn rather than imply completeness. |
| Workspace memory | 500 entries | Least-recently-updated dropped first. |
| Checkpoints | 100 | Oldest dropped first, blobs garbage-collected against the reachable set. |
| Checkpoint blobs | Content-addressed | Identical content stored once, so repeated snapshots of the same file cost one copy. |
| Mention completions | 12 files + 8 symbols | Beyond that a list stops being a menu and becomes a haystack. |
| Inline diff review | One string per file | Hunks are recomputed, never stored, so review state cannot accumulate. |

## Test suite

Kept fast enough to run on every change: **456 core tests in 0.6 s**, 89 webview
tests in ~0.9 s. The 10 integration tests need a real editor and run after the
build, which is why they are a separate script rather than part of `pnpm test`.

Coverage concentrates in `core` precisely because the dependency rule made it
cheap to test there — that is a performance property of the *development* loop,
and it is the reason the slow harness stays thin.
