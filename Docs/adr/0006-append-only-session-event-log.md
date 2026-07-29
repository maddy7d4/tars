# ADR 0006 — Append-only session event log as the persistence primitive

**Status:** Accepted
**Date:** 2026-07-30
**Deciders:** Founding engineering
**Related:** [TARS_SPEC.md](../TARS_SPEC.md) §4.3, §6.4, §3.2, §2

## Context

Three features in the delivery plan look independent and are routinely built independently. **Conversation history** (phase 5) needs past sessions readable and resumable. **Checkpoint and restore** (phase 3) needs a point-in-time record of both the workspace and the conversation, so that undoing an AI change also rewinds the dialogue that produced it. **Crash recovery** needs a session interrupted by an extension-host crash or a killed editor to come back without corruption.

Built separately, these are three storage designs: a conversation database, a checkpoint store with its own metadata, and a recovery journal. Each needs its own schema, its own migration story, and its own consistency rules — and the three must then agree with one another, because a checkpoint that references a conversation position is meaningless if the conversation store cannot address positions.

The observation that collapses them is that [ADR 0004](0004-normalized-agent-event-union.md) already produces a totally ordered stream of `AgentEvent` values for every session. That stream *is* the session. Everything the three features need is either the stream itself or an offset into it. A conversation is the stream replayed. A checkpoint is a workspace snapshot plus an offset. Crash recovery is the stream truncated at the last complete record.

The remaining question is the write pattern. Mutable state — a document rewritten in place, or a database updated transactionally — introduces the failure mode that matters here: a crash mid-write can leave the store in a state that is neither the old one nor the new one, and recovering from that requires exactly the kind of consistency machinery the design is trying to avoid. Append-only writes have a strictly simpler failure mode: the only possible damage is a partial record at the tail, which is detectable and discardable.

## Decision

A session is an **append-only event log**: JSONL, one file per session, stored under `globalStorageUri` through `StoragePort`. Writes are append-only and **fsync-batched**. No record is ever mutated or deleted in place.

One primitive yields three features:

| Feature | Implementation |
|---|---|
| Conversation history | Replay the log. |
| Checkpoint / restore (§6.4) | A checkpoint record references content hashes of snapshotted files plus the **session event offset**. |
| Crash recovery | Truncate at the last complete record. |

Because checkpoints reference the session log offset, **restoring workspace state and rewinding the conversation are the same operation**. Three subsystems collapse into one.

Records are written by `core`, which reaches storage through `StoragePort` and timestamps through `ClockPort` ([ADR 0003](0003-core-host-webview-split.md)). Injecting the clock is what makes log ordering assertions deterministic in tests rather than flaky against a real clock.

File snapshots for checkpoints live in a separate content-addressed store under `globalStorageUri`, SHA-256 keyed, so identical content is stored once. The event log holds hashes, not file contents.

## Alternatives Considered

| Alternative | Genuine advantage | Reason rejected |
|---|---|---|
| **SQLite (or a bundled embedded database)** | Real queries, indexes, transactions, and ACID guarantees. Searching across sessions — by date, by file touched, by tool used — would be trivial, and phase 5's history UI would be cheap. | A native dependency to bundle and version per platform inside a `.vsix`, plus a schema and migration burden, in exchange for query power v1 does not need. Ordered append and offset addressing are the access patterns; both are native to a log. Revisitable if cross-session search becomes a requirement. |
| **A mutable JSON document per session, rewritten on change** | Trivial to implement and to inspect; the whole session is one readable object. | Rewrite cost grows with session length, and a crash mid-write can corrupt the entire session rather than one record. It also has no natural notion of an offset, which is precisely what checkpoints need. |
| **Three separate stores — history, checkpoints, recovery journal** | Each store optimally shaped for its own feature, and each independently evolvable. | Three schemas, three migration paths, and a cross-store consistency invariant (checkpoints must address conversation positions) that must be maintained by hand. The log makes that invariant an integer. |
| **Rely on the SDK's own session resume** | The SDK already supports session resume, so no persistence code at all. | Insufficient and misplaced. The SDK's resume covers its own conversation state, not TARS's checkpoints, change sets, `@`-mention context items, or the normalized event stream the UI replays — and depending on the internal format of a pre-1.0 dependency for durable user data is exactly the coupling [ADR 0004](0004-normalized-agent-event-union.md) exists to prevent. |
| **In-memory only, nothing persisted** | Zero storage code, zero disk growth, no privacy surface. | Forfeits conversation history, checkpoints, and crash recovery — three delivery-plan features (phases 3 and 5). |
| **Git-based snapshots for checkpoints** | Reuses a tool already present, with excellent content addressing and diffing for free. | Writing to the user's repository history — even to a side ref — mutates state the user owns and expects to control, and it fails for workspaces that are not Git repositories. A private content-addressed store has none of those problems. |

## Consequences

### Positive
- Three features share one primitive, one format, and one set of tests. The largest complexity reduction in the persistence layer.
- Restore and conversation rewind are the same operation, so they cannot disagree — a class of bug eliminated by construction rather than by care.
- The crash failure mode is bounded: at worst a partial trailing record, detected and truncated.
- JSONL is line-oriented and human-readable, so a session is inspectable with standard tools during development and diagnosable from a user-supplied file.
- fsync batching keeps the write path off the hot streaming path, so persistence does not stall `text_delta` rendering.
- Content-addressed snapshots deduplicate identical file content automatically.
- The whole design is testable in `core` under Vitest with an in-memory `StoragePort` and a deterministic `ClockPort`.

### Negative
- No query capability. Filtering, aggregating, or searching across sessions means reading logs, which does not scale to a cross-session search feature without an added index.
- Logs grow monotonically. A retention or compaction policy is required before v1 ships, or long-lived installations accumulate disk usage indefinitely.
- Replay cost is linear in session length, so resuming a very long conversation is an O(n) read.
- Record format changes must be handled by version-tagging records and reading older variants; the log is durable user data and cannot be reformatted in place.

### Neutral / accepted costs
- Deletion is not in-place. Removing a session means removing its file, and removing a single turn is not supported — the log is the record.
- Two stores exist on disk (the event log and the content-addressed snapshot store), joined by hashes. That is deliberate: the log stays small and line-oriented, and large blobs deduplicate.
- Session data lives under `globalStorageUri`, not in the workspace, so it is not committed and does not follow a cloned repository.
- Append-only means an event emitted in error is still in the log; correction is a subsequent record, not an edit.

## Revisit If
- Cross-session search or filtering becomes a requirement rather than a nice-to-have. That is the specific capability a log lacks and an embedded database supplies, and it is the strongest trigger to reopen this decision.
- Replaying a session at the 95th percentile of real session length exceeds the phase 6 latency budget for opening a conversation, indicating an index or snapshot-of-state optimization is needed.
- Total on-disk session storage for an active user grows past a level a retention policy can reasonably manage, requiring compaction that the append-only rule cannot express.
- Truncation-based crash recovery is observed failing to recover a real interrupted session — for example because fsync batching lost more than the trailing record — in which case the batching policy, not the log, is at fault and must be tightened.
- A record-format migration proves unmanageable through version-tagged records, indicating the format needs a stronger schema than JSONL provides.
