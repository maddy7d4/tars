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

/** Messages the extension host sends into the webview. */
export type HostToWebview =
  | ReadyMessage
  | AgentEventMessage
  | SessionStateMessage
  | PermissionResolvedMessage
  | ConfigMessage
  | HostErrorMessage;

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

/** Messages the webview sends to the extension host. All privilege stays host-side. */
export type WebviewToHost =
  | WebviewReadyMessage
  | SendPromptMessage
  | InterruptMessage
  | PermissionDecisionMessage
  | OpenFileMessage
  | NewSessionMessage;
