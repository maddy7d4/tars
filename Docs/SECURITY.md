# Security posture

Written as part of phase 6. Every claim below was verified against the source at
the time of writing; where a property is enforced by a test, the test is named.

## 1. Threat model

TARS runs an AI agent with the user's own filesystem and shell privileges inside
their editor. The realistic threats, in order of how much damage they do:

| Threat | Where it is addressed |
|---|---|
| The agent runs a destructive command the user did not intend | §2 Permission gating |
| A prompt injection in file content escalates the agent's reach | §2, §3 |
| An edit silently overwrites work the user cannot recover | §4 Checkpoints |
| Credentials leak into logs, the webview, or the `.vsix` | §5 Secrets |
| Malicious content reaches the webview and executes | §6 Webview isolation |
| A corrupt on-disk record is turned into a filesystem path | §7 Path handling |
| A third-party MCP server acts unattended | §8 MCP |

Out of scope for v1: a hostile *user* (TARS grants no privilege the user does not
already have), and a compromised editor or OS.

## 2. Permission gating

`canUseTool` is the single point at which a tool is either held for the user or
handed to the model. Everything else in this document is secondary to it.

- Destructive and outward-facing tools default to `ask` **regardless of the
  session default**: `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`,
  `WebSearch`, and every `mcp__*` tool.
- Resolution takes the **stricter** of the session default and `ask`, so a
  session set to `always_allow` still stops at a shell command, and one set to
  `deny` is not loosened into a prompt.
- Missing approval channel **fails closed**: a headless session, or one whose
  webview never mounted, denies every gated tool rather than allowing it.
- An interrupt while a prompt is outstanding resolves it as a denial rather than
  leaving the promise pending, which would wedge the session.
- `permissionMode` is pinned to `'default'`. `bypassPermissions` would remove
  TARS's policy from the loop entirely.

Session-scoped promotion (`Always allow`) is held on the broker, whose lifetime
*is* the session's, and is consulted **only after the deny short-circuit** — so a
tool the policy denies can never reach the line that records a grant. Promotion
never persists beyond the session; making it durable is a settings decision,
where it is visible and revocable.

Covered by `packages/core/src/provider/claude-code/permission.test.ts` (36
tests), including the default-gating invariant asserted per tool rather than
inferred from a happy path.

## 3. Prompt injection

TARS does not attempt to detect prompt injection; no reliable detector exists.
The mitigation is structural: **injected instructions cannot exceed the
permission gate.** Content read from a file can persuade the model to attempt a
destructive tool call, and that call still stops at §2.

Two supporting properties:

- Tool arguments are rendered **verbatim** in the approval prompt, never
  summarised. Summarising could hide the one field — a path, a flag, a URL — the
  decision actually turns on.
- `toJsonValue` sanitises tool input before it reaches both the prompt and the
  session log, and honours `toJSON()` so a `Date` renders as an instant rather
  than an empty object. A throwing `toJSON` falls back to structural conversion
  rather than taking down serialisation.

## 4. Recoverability

Every file the agent writes is snapshotted **before** the tool runs, from the
`file_edit_proposed` event the SDK emits before execution. The checkpoint record
is re-persisted after each file rather than at turn end, so a crash mid-turn
still leaves a way back. The first snapshot of a path wins — a later baseline
would be the agent's own output.

Reverts and restores go through a single `vscode.WorkspaceEdit`, so they land in
the editor's own undo stack and a mistaken revert is recovered with `Ctrl+Z`.

## 5. Secrets

- The API key is read from `SecretsPort`, backed by `vscode.SecretStorage` — the
  OS keychain — and never from settings, where it would land in a synced,
  world-readable JSON file.
- It is passed to the SDK subprocess through `env` and appears in **no** log
  record, event, or webview message. The event log is JSONL of `AgentEvent`s, and
  no member of that union carries credentials.
- The zero-config path uses the SDK's own OAuth, so most users have no key for
  TARS to hold at all.

## 6. Webview isolation

The panel's CSP is `default-src 'none'` with a per-load 128-bit nonce for the one
module script. There is **no `connect-src`**, so the webview cannot make network
requests of any kind. `localResourceRoots` is narrowed to `dist/webview`, so it
can read its own assets and nothing else on disk.

The webview holds no privilege: it cannot open a file, resolve a path, or read
the index. Every such action is a message to the host, which performs it.
`@`-mention completion is a round trip for exactly this reason — pushing the
workspace's file list into the sandbox would leak its shape.

No `eval`, no `new Function`, no `innerHTML`, no `dangerouslySetInnerHTML`
anywhere in the webview. Prompt text renders with `whitespace-pre-wrap` and never
becomes markup.

A protocol-version mismatch stops the webview parsing further messages entirely:
a stale bundle interpreting an incompatible union renders plausible nonsense,
which is worse than rendering nothing.

## 7. Path handling

Content-addressed blob ids go straight into filenames, so `isContentHash` gates
every read, write and delete: a corrupt record cannot address anything outside
the store. Garbage collection takes the **reachable** set rather than a delete
list, so a caller that forgets a checkpoint retains garbage instead of destroying
live data.

One resolver handles every path arriving from an event or the webview, so a
relative path cannot silently become a URI rooted at the filesystem root.

## 8. MCP servers

Configured servers are third-party code reaching outward, so every tool they
expose is gated as a class by the `mcp__` prefix rule in §2. Configuring a server
says it may run, not that it may run unattended.

Entries are validated per server rather than trusted: the manifest's JSON schema
constrains the settings UI, but a hand-edited `settings.json` can carry anything.
A malformed entry is dropped and named in the log rather than failing the whole
session.

## 9. Supply chain

- `pnpm` with `nodeLinker: isolated` — no implicit hoisting, so a package cannot
  resolve a module it did not declare.
- `onlyBuiltDependencies` is an allowlist. A dependency that runs code at install
  time is a reviewed decision, not a default.
- CI installs with `--frozen-lockfile`.
- The `.vsix` ships **10 files**: the manifest, readme, licence, one bundle, and
  the webview assets. No `node_modules`, no tests, no source maps. `.vscodeignore`
  excludes everything and adds back only `dist/`, so the shipped set cannot drift
  as the tree grows.

## 10. Network behaviour

TARS makes no network requests of its own. There is no telemetry, no analytics,
and no update check. The only outbound traffic is the Agent SDK's own, to
Anthropic, from the subprocess it owns.

## 11. Known limitations

- **Prompt injection is mitigated, not solved** (§3). A user who approves a tool
  call without reading it has approved it.
- **`Always allow` is per session but per *tool*, not per argument.** Promoting
  `Bash` promotes every shell command for that session, not the one approved.
  Argument-scoped promotion is a v2 consideration.
- **A stale change is reported, not prevented.** If a file moves between the
  agent reading and writing it, the review flags the file — but the write has
  already happened, and recovery is the checkpoint.
