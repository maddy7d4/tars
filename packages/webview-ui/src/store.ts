import { create } from 'zustand';
import {
  assertNever,
  PROTOCOL_VERSION,
  type ContextItem,
  type HostToWebview,
  type PermissionPolicy,
} from '@tars/shared';
import {
  appendHostError,
  appendUserPrompt,
  applyAgentEvent,
  createTranscript,
  replayTranscript,
  resolvePermission,
  type PendingPermission,
  type TranscriptBuffer,
  type TranscriptItem,
  type UsageTotals,
} from './transcript.js';
import { postToHost } from './vscode-api.js';

export type {
  AssistantItem,
  ErrorItem,
  FileEditItem,
  PendingPermission,
  PlanItem,
  ThinkingItem,
  ToolCallItem,
  ToolCallStatus,
  TranscriptItem,
  UsageTotals,
  UserItem,
} from './transcript.js';

export interface TarsState {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly sessionId: string | null;
  readonly permissionPolicy: PermissionPolicy;
  readonly workspaceName: string | null;
  readonly pendingPermissions: readonly PendingPermission[];
  readonly usage: UsageTotals | null;
  readonly lastError: string | null;
  /**
   * True once the host announced a protocol version this bundle cannot read. Every
   * later message is dropped: a stale webview that keeps parsing an incompatible
   * union renders plausible nonsense, which is strictly worse than rendering nothing.
   */
  readonly protocolMismatch: boolean;

  /**
   * The live transcript array. Its identity is stable by design (see `TranscriptBuffer`),
   * so components must subscribe through `useTranscript`, never to this field.
   */
  readonly transcript: readonly TranscriptItem[];
  /** Bumped whenever `transcript` changes, since its identity cannot say so. */
  readonly revision: number;

  /** Single entry point for host messages, so the reducer stays exhaustive. */
  readonly receive: (message: HostToWebview) => void;
  /** Echoes the prompt locally and hands it to the host, which owns every privilege. */
  readonly sendPrompt: (text: string, context?: readonly ContextItem[]) => void;
}

/**
 * The buffer lives outside the store because it is mutable by design and zustand's
 * job here is publishing change notifications, not owning the data structure.
 */
let buffer: TranscriptBuffer = createTranscript();

/** Fields the reducer derives; lifted out so live and replayed paths publish identically. */
function published(current: TranscriptBuffer): Pick<
  TarsState,
  'transcript' | 'pendingPermissions' | 'busy' | 'lastError' | 'usage'
> {
  return {
    transcript: current.items,
    pendingPermissions: current.pendingPermissions,
    busy: current.busy,
    lastError: current.lastError,
    usage: current.usage,
  };
}

export const useTarsStore = create<TarsState>((set, get) => ({
  connected: false,
  busy: false,
  sessionId: null,
  permissionPolicy: 'ask',
  workspaceName: null,
  pendingPermissions: [],
  usage: null,
  lastError: null,
  protocolMismatch: false,
  transcript: buffer.items,
  revision: 0,

  receive: (message) => {
    set((state) => {
      if (state.protocolMismatch) {
        return {};
      }

      switch (message.type) {
        case 'ready':
          // Compared rather than trusted: the `.vsix` ships both halves together, but
          // a live window can keep a stale webview across an extension update.
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            return {
              connected: false,
              protocolMismatch: true,
              lastError:
                `TARS protocol mismatch: the extension speaks version ${String(message.protocolVersion)}, ` +
                `this view speaks ${String(PROTOCOL_VERSION)}. Reload the window to update it.`,
            };
          }
          return { connected: true };

        case 'agent_event':
          applyAgentEvent(buffer, message.event);
          return { ...published(buffer), revision: state.revision + 1 };

        case 'session_state':
          // Replay rebuilds through the same reducer, so a resumed session renders
          // exactly as it did live. `busy` comes from the host, which alone knows
          // whether a turn is still running behind the last persisted event.
          buffer = replayTranscript(message.history);
          buffer.busy = message.busy;
          return {
            ...published(buffer),
            busy: message.busy,
            sessionId: message.sessionId,
            revision: state.revision + 1,
          };

        case 'permission_resolved':
          resolvePermission(buffer, message.requestId);
          return { ...published(buffer), revision: state.revision + 1 };

        case 'config':
          return {
            permissionPolicy: message.permissionPolicy,
            workspaceName: message.workspaceName,
          };

        case 'host_error':
          appendHostError(buffer, message.message);
          return { ...published(buffer), revision: state.revision + 1 };

        default:
          return assertNever(message);
      }
    });
  },

  sendPrompt: (text, context = []) => {
    const trimmed = text.trim();
    if (trimmed === '' || get().busy) {
      return;
    }
    appendUserPrompt(buffer, trimmed);
    // Optimistic: the host will confirm with `turn_start`, but the input must lock
    // immediately or a fast second Enter submits into a turn that already exists.
    set((state) => ({ ...published(buffer), busy: true, revision: state.revision + 1 }));
    postToHost({ type: 'send_prompt', text: trimmed, context });
  },
}));

/**
 * Subscribes to transcript changes. The array is mutated in place to keep token
 * appends O(1), so `revision` — not the array's identity — is the signal React can act on.
 */
export function useTranscript(): readonly TranscriptItem[] {
  const revision = useTarsStore((state) => state.revision);
  void revision;
  return useTarsStore.getState().transcript;
}

/** Test seam: drops the module-level buffer so cases start from an empty transcript. */
export function resetTarsStore(): void {
  buffer = createTranscript();
  useTarsStore.setState({
    connected: false,
    busy: false,
    sessionId: null,
    permissionPolicy: 'ask',
    workspaceName: null,
    pendingPermissions: [],
    usage: null,
    lastError: null,
    protocolMismatch: false,
    transcript: buffer.items,
    revision: 0,
  });
}
