import { create } from 'zustand';
import {
  assertNever,
  type AgentEvent,
  type HostToWebview,
  type PermissionPolicy,
} from '@tars/shared';

/** A pending approval the user must resolve before the agent can continue (§4.2). */
export interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
  readonly affectedPaths: readonly string[];
}

export interface TarsState {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly sessionId: string | null;
  readonly permissionPolicy: PermissionPolicy;
  readonly workspaceName: string | null;
  /** Assistant prose for the current turn, accumulated from `text_delta`. */
  readonly assistantText: string;
  readonly pendingPermissions: readonly PendingPermission[];
  readonly lastError: string | null;

  /** Single entry point for host messages, so the reducer stays exhaustive. */
  readonly receive: (message: HostToWebview) => void;
}

function applyEvent(state: TarsState, event: AgentEvent): Partial<TarsState> {
  switch (event.type) {
    case 'turn_start':
      // Clearing here rather than on send means a resumed or replayed session
      // starts each turn from a known state regardless of how it was entered.
      return { assistantText: '', busy: true, lastError: null };
    case 'text_delta':
      // Appending a string rather than pushing a node keeps streaming O(1) per
      // delta; virtualization of the full transcript arrives with phase 2.
      return { assistantText: state.assistantText + event.text };
    case 'permission_request':
      return {
        pendingPermissions: [
          ...state.pendingPermissions,
          {
            requestId: event.requestId,
            toolName: event.toolName,
            affectedPaths: event.affectedPaths,
          },
        ],
      };
    case 'error':
      return { lastError: event.message };
    case 'turn_end':
      return { busy: false };
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'tool_call_start':
    case 'tool_call_delta':
    case 'tool_call_result':
    case 'plan_update':
    case 'file_edit_proposed':
    case 'usage':
      // Rendered by the timeline and plan views introduced in phase 2; ignoring
      // them here is a deliberate, exhaustively-checked choice, not an omission.
      return {};
    default:
      return assertNever(event);
  }
}

export const useTarsStore = create<TarsState>((set) => ({
  connected: false,
  busy: false,
  sessionId: null,
  permissionPolicy: 'ask',
  workspaceName: null,
  assistantText: '',
  pendingPermissions: [],
  lastError: null,

  receive: (message) => {
    set((state) => {
      switch (message.type) {
        case 'ready':
          return { connected: true };
        case 'agent_event':
          return applyEvent(state, message.event);
        case 'session_state':
          return {
            sessionId: message.sessionId,
            busy: message.busy,
            assistantText: message.history.reduce(
              (text, event) => (event.type === 'text_delta' ? text + event.text : text),
              '',
            ),
            pendingPermissions: [],
          };
        case 'permission_resolved':
          return {
            pendingPermissions: state.pendingPermissions.filter(
              (pending) => pending.requestId !== message.requestId,
            ),
          };
        case 'config':
          return {
            permissionPolicy: message.permissionPolicy,
            workspaceName: message.workspaceName,
          };
        case 'host_error':
          return { lastError: message.message };
        default:
          return assertNever(message);
      }
    });
  },
}));
