import type { SessionId } from './brand.js';
import type { AgentEvent, PermissionPolicy } from './events.js';
import type { ContextItem } from './turn.js';

/**
 * Bumped whenever either message union changes shape incompatibly. The webview
 * bundle and the extension host are versioned together in the `.vsix`, but a
 * stale webview can survive an extension update in a live window; the handshake
 * lets the host detect that instead of silently mis-parsing messages.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Confirms the host and webview agree on `PROTOCOL_VERSION`. */
export interface ReadyMessage {
  readonly type: 'ready';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

/** A normalized agent event forwarded to the renderer. */
export interface AgentEventMessage {
  readonly type: 'agent_event';
  readonly event: AgentEvent;
}

/** A session was created or resumed; the renderer resets its transcript to `history`. */
export interface SessionStateMessage {
  readonly type: 'session_state';
  readonly sessionId: SessionId;
  readonly busy: boolean;
  readonly history: readonly AgentEvent[];
}

/** Resolution of a pending permission request, echoed so the UI can retire the prompt. */
export interface PermissionResolvedMessage {
  readonly type: 'permission_resolved';
  readonly requestId: string;
  readonly decision: PermissionPolicy;
}

/** Host-side configuration the renderer needs, pushed on change rather than polled. */
export interface ConfigMessage {
  readonly type: 'config';
  readonly permissionPolicy: PermissionPolicy;
  readonly workspaceName: string | null;
}

/** A host-side failure surfaced in the UI rather than only the output channel. */
export interface HostErrorMessage {
  readonly type: 'host_error';
  readonly message: string;
}

/**
 * One file the agent changed, summarised for review (Docs/TARS_SPEC.md §6.1).
 *
 * Content and hunks stay in the host. The webview needs enough to list what
 * changed and how much, and the actual diff is reviewed in the editor's own diff
 * viewer (§6.2) — shipping file contents across `postMessage` for every proposal
 * would cost more than the review UI it feeds.
 */
export interface PendingChangeSummary {
  readonly path: string;
  readonly kind: 'create' | 'modify' | 'delete';
  readonly added: number;
  readonly removed: number;
  /** The edit was computed against content that has since changed on disk. */
  readonly stale: boolean;
}

/**
 * The change set awaiting review, pushed whenever it changes. An empty `changes`
 * array means there is nothing to review, which is how the review bar retires.
 */
export interface ChangeSetMessage {
  readonly type: 'change_set';
  readonly changes: readonly PendingChangeSummary[];
  readonly added: number;
  readonly removed: number;
}

/**
 * One completion for an `@`-mention.
 *
 * `detail` is the containing directory rather than the full path: the label
 * already carries the basename, and a list of full paths is unreadable at panel
 * width. The host sends the full path separately because that is what gets
 * inserted.
 */
export interface MentionCandidate {
  readonly kind: 'file' | 'symbol' | 'selection' | 'diagnostics';
  /** What the user sees, e.g. a basename or symbol name. */
  readonly label: string;
  /** What is inserted into the prompt, without the leading `@`. */
  readonly insert: string;
  /** Secondary text, e.g. the containing directory or a symbol's kind. */
  readonly detail: string;
}

/**
 * Completions for the query the webview asked about.
 *
 * Carries the `query` back so a late reply for a prefix the user has already
 * typed past can be discarded. Without it a slow response would repopulate the
 * list with results for text that is no longer there.
 */
export interface MentionResultsMessage {
  readonly type: 'mention_results';
  readonly query: string;
  readonly candidates: readonly MentionCandidate[];
}

/** Messages the extension host sends into the webview. */
export type HostToWebview =
  | ReadyMessage
  | AgentEventMessage
  | SessionStateMessage
  | PermissionResolvedMessage
  | ConfigMessage
  | HostErrorMessage
  | ChangeSetMessage
  | MentionResultsMessage;

/** The renderer finished mounting and is able to receive messages. */
export interface WebviewReadyMessage {
  readonly type: 'webview_ready';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

/** The user submitted a prompt. The webview never resolves paths itself. */
export interface SendPromptMessage {
  readonly type: 'send_prompt';
  readonly text: string;
  readonly context: readonly ContextItem[];
}

/** The user asked to stop the running turn. */
export interface InterruptMessage {
  readonly type: 'interrupt';
}

/** The user decided a pending permission request. */
export interface PermissionDecisionMessage {
  readonly type: 'permission_decision';
  readonly requestId: string;
  readonly decision: PermissionPolicy;
}

/** The user asked to open a workspace file at a position; only the host has that privilege. */
export interface OpenFileMessage {
  readonly type: 'open_file';
  readonly path: string;
  readonly line?: number;
}

/** The user asked to start a fresh session, discarding the current transcript from view. */
export interface NewSessionMessage {
  readonly type: 'new_session';
}

/**
 * What the user decided about the change set the agent just made.
 *
 * The verbs are `keep` and `revert`, not `apply` and `discard`, because the
 * edits are already on disk: Claude Code's `Write` and `Edit` tools write to the
 * workspace themselves, and TARS gates them at the permission prompt rather than
 * holding their output. So review is post-hoc — `keep` dismisses it, and
 * `revert` restores the checkpoint taken before the tools ran (§6.4).
 *
 * `review` opens one file in the editor's native diff viewer (§6.2).
 */
export interface ReviewActionMessage {
  readonly type: 'review_action';
  readonly action: 'keep' | 'revert' | 'review';
  /** Required for `review`; ignored otherwise. */
  readonly path?: string;
}

/**
 * Asks for `@`-mention completions.
 *
 * The webview holds no index — resolving a path is a privileged operation and
 * the index lives in core (Docs/TARS_SPEC.md §5.1, §7.2). So completion is a
 * round trip rather than a local filter over a pushed file list, which would
 * mean shipping every path in the workspace across `postMessage` on connect.
 */
export interface MentionQueryMessage {
  readonly type: 'mention_query';
  readonly query: string;
}

/** Messages the webview sends to the extension host. All privilege stays host-side. */
export type WebviewToHost =
  | WebviewReadyMessage
  | SendPromptMessage
  | InterruptMessage
  | PermissionDecisionMessage
  | OpenFileMessage
  | NewSessionMessage
  | ReviewActionMessage
  | MentionQueryMessage;
