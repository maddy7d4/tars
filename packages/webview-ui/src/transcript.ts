import {
  assertNever,
  type AgentEvent,
  type JsonValue,
  type PermissionPolicy,
  type PlanStep,
  type ToolCallId,
} from '@tars/shared';

/**
 * The transcript is the renderer's whole model of a conversation: an ordered list
 * of immutable items derived from the `AgentEvent` stream (Docs/TARS_SPEC.md §4.1).
 * Ordering is derived from arrival, never from event type, because prose, thinking
 * and tool calls interleave and any reordering would misrepresent what the agent did.
 */

/** A prompt the user submitted, echoed locally so the turn reads as a conversation. */
export interface UserItem {
  readonly kind: 'user';
  readonly id: string;
  readonly text: string;
}

/** A block of assistant prose. `streaming` is true only while deltas may still arrive. */
export interface AssistantItem {
  readonly kind: 'assistant';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** An extended-thinking block, collapsed by default and closed only by `thinking_end`. */
export interface ThinkingItem {
  readonly kind: 'thinking';
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** `pending` means the call is still in flight; the other two mirror `isError`. */
export type ToolCallStatus = 'pending' | 'ok' | 'error';

export interface ToolCallItem {
  readonly kind: 'tool_call';
  readonly id: string;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Kept as raw text: a partial JSON input is not parseable while it streams. */
  readonly inputJson: string;
  readonly status: ToolCallStatus;
  readonly result: string | null;
  readonly durationMs: number | null;
  /**
   * Derived once the input is complete, which is why it is empty while pending:
   * re-parsing the accumulated JSON on every delta would make streaming quadratic.
   */
  readonly affectedPaths: readonly string[];
}

/** The agent's task list. Replaced wholesale — `plan_update` is never a patch. */
export interface PlanItem {
  readonly kind: 'plan';
  readonly id: string;
  readonly steps: readonly PlanStep[];
}

export interface FileEditItem {
  readonly kind: 'file_edit';
  readonly id: string;
  readonly path: string;
  readonly summary: string;
  readonly isNewFile: boolean;
}

export interface ErrorItem {
  readonly kind: 'error';
  readonly id: string;
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolCallItem
  | PlanItem
  | FileEditItem
  | ErrorItem;

/** A pending approval the user must resolve before the agent can continue (§4.2). */
export interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
  /** Rendered verbatim for review; the shape is tool-specific and not ours to interpret. */
  readonly input: JsonValue;
  readonly affectedPaths: readonly string[];
  readonly defaultPolicy: PermissionPolicy;
}

/** Cumulative token accounting for the current turn. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * The reducer's working set.
 *
 * `items` is deliberately a mutable array while the items inside it are immutable.
 * A streamed token must cost O(1): copying the array per `text_delta` would make a
 * long transcript quadratic in tokens, which is exactly the paint-time regression
 * §5.2 warns about. Item identity still changes on every edit, so `React.memo`
 * re-renders only the row that actually moved, and the store publishes a `revision`
 * counter for the array itself (whose identity can no longer signal change).
 *
 * The open-block cursors are indices rather than object references so that closing
 * a block is a slot assignment rather than a search.
 */
export interface TranscriptBuffer {
  readonly items: TranscriptItem[];
  pendingPermissions: readonly PendingPermission[];
  usage: UsageTotals | null;
  busy: boolean;
  lastError: string | null;
  /** Index of the assistant block currently receiving prose, or -1. */
  openAssistant: number;
  /** Index of the thinking block currently open, or -1. Survives interleaved tool calls. */
  openThinking: number;
  /** Index of the plan item, or -1. One per session; `plan_update` replaces it. */
  planIndex: number;
  readonly toolIndex: Map<ToolCallId, number>;
  seq: number;
}

const NO_PATHS: readonly string[] = [];

export function createTranscript(): TranscriptBuffer {
  return {
    items: [],
    pendingPermissions: [],
    usage: null,
    busy: false,
    lastError: null,
    openAssistant: -1,
    openThinking: -1,
    planIndex: -1,
    toolIndex: new Map<ToolCallId, number>(),
    seq: 0,
  };
}

/**
 * Ids are derived from a per-buffer counter rather than a clock or `crypto.randomUUID`
 * so that replaying a history produces byte-identical items to live delivery — the
 * property the replay test asserts, and the reason there is only one code path.
 */
function nextId(buffer: TranscriptBuffer, kind: string): string {
  buffer.seq += 1;
  return `${kind}-${String(buffer.seq)}`;
}

function itemAt(buffer: TranscriptBuffer, index: number): TranscriptItem | undefined {
  return index >= 0 ? buffer.items[index] : undefined;
}

/** Closes the open prose block. Called wherever a different kind of block begins. */
function closeAssistant(buffer: TranscriptBuffer): void {
  const open = itemAt(buffer, buffer.openAssistant);
  if (open !== undefined && open.kind === 'assistant') {
    buffer.items[buffer.openAssistant] = { ...open, streaming: false };
  }
  buffer.openAssistant = -1;
}

function closeThinking(buffer: TranscriptBuffer): void {
  const open = itemAt(buffer, buffer.openThinking);
  if (open !== undefined && open.kind === 'thinking') {
    buffer.items[buffer.openThinking] = { ...open, streaming: false };
  }
  buffer.openThinking = -1;
}

/**
 * Returns the open prose block, opening one if needed. Creating on first delta
 * rather than on `turn_start` keeps an empty bubble off screen for turns that open
 * with thinking or a tool call.
 */
function currentAssistant(buffer: TranscriptBuffer): AssistantItem {
  const open = itemAt(buffer, buffer.openAssistant);
  if (open !== undefined && open.kind === 'assistant') {
    return open;
  }
  const created: AssistantItem = {
    kind: 'assistant',
    id: nextId(buffer, 'assistant'),
    text: '',
    streaming: true,
  };
  buffer.openAssistant = buffer.items.length;
  buffer.items.push(created);
  return created;
}

function currentThinking(buffer: TranscriptBuffer): ThinkingItem {
  const open = itemAt(buffer, buffer.openThinking);
  if (open !== undefined && open.kind === 'thinking') {
    return open;
  }
  const created: ThinkingItem = {
    kind: 'thinking',
    id: nextId(buffer, 'thinking'),
    text: '',
    streaming: true,
  };
  buffer.openThinking = buffer.items.length;
  buffer.items.push(created);
  return created;
}

function currentToolCall(
  buffer: TranscriptBuffer,
  toolCallId: ToolCallId,
  toolName: string,
): { readonly index: number; readonly item: ToolCallItem } {
  const index = buffer.toolIndex.get(toolCallId);
  const existing = index === undefined ? undefined : buffer.items[index];
  if (index !== undefined && existing !== undefined && existing.kind === 'tool_call') {
    return { index, item: existing };
  }
  // A delta or result without its `tool_call_start` means a truncated log, not a bug
  // worth losing the rest of the transcript over; synthesize the row and carry on.
  const created: ToolCallItem = {
    kind: 'tool_call',
    id: nextId(buffer, 'tool'),
    toolCallId,
    toolName,
    inputJson: '',
    status: 'pending',
    result: null,
    durationMs: null,
    affectedPaths: NO_PATHS,
  };
  const appended = buffer.items.length;
  buffer.items.push(created);
  buffer.toolIndex.set(toolCallId, appended);
  return { index: appended, item: created };
}

/** `JSON.parse` types its result `any`; this is the single place that boundary is crossed. */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Tool inputs are tool-specific and not ours to interpret, but the conventional
 * path-bearing keys cover every filesystem tool Claude Code ships, and showing the
 * touched files is the difference between an auditable tool call and an opaque one.
 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'filepath'] as const;

function extractPaths(inputJson: string): readonly string[] {
  if (inputJson === '') {
    return NO_PATHS;
  }
  let parsed: unknown;
  try {
    parsed = parseJson(inputJson);
  } catch {
    // Partial or malformed input is expected, not exceptional: render nothing.
    return NO_PATHS;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NO_PATHS;
  }
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') {
      paths.push(value);
    }
  }
  return paths.length === 0 ? NO_PATHS : paths;
}

function describeEdit(afterContent: string, isNewFile: boolean): string {
  const lines = afterContent === '' ? 0 : afterContent.split('\n').length;
  return `${isNewFile ? 'created' : 'modified'} · ${String(lines)} ${lines === 1 ? 'line' : 'lines'}`;
}

/**
 * Applies one normalized event to the buffer, in place.
 *
 * Every consumer — live `agent_event` delivery and `session_state` replay alike —
 * goes through this function. Two code paths would mean a replayed conversation
 * could render differently from the one the user watched arrive, and that class of
 * divergence is invisible until a user reopens a session and sees a different story.
 */
export function applyAgentEvent(buffer: TranscriptBuffer, event: AgentEvent): void {
  switch (event.type) {
    case 'turn_start': {
      // Closing here rather than trusting the previous turn to have terminated cleanly
      // means an interrupted or crashed turn cannot leave a block streaming forever.
      closeAssistant(buffer);
      closeThinking(buffer);
      buffer.busy = true;
      buffer.lastError = null;
      return;
    }

    case 'text_delta': {
      const item = currentAssistant(buffer);
      // String concatenation plus one slot assignment: O(1) per token, no array copy.
      buffer.items[buffer.openAssistant] = { ...item, text: item.text + event.text };
      return;
    }

    case 'thinking_start': {
      closeAssistant(buffer);
      currentThinking(buffer);
      return;
    }

    case 'thinking_delta': {
      const item = currentThinking(buffer);
      buffer.items[buffer.openThinking] = { ...item, text: item.text + event.text };
      return;
    }

    case 'thinking_end': {
      closeThinking(buffer);
      return;
    }

    case 'tool_call_start': {
      // The prose block ends here so that text written before the call renders above
      // it and text written after renders below it — the ordering the user watched.
      closeAssistant(buffer);
      currentToolCall(buffer, event.toolCallId, event.toolName);
      return;
    }

    case 'tool_call_delta': {
      const { index, item } = currentToolCall(buffer, event.toolCallId, '');
      buffer.items[index] = { ...item, inputJson: item.inputJson + event.inputJsonDelta };
      return;
    }

    case 'tool_call_result': {
      const { index, item } = currentToolCall(buffer, event.toolCallId, event.toolName);
      buffer.items[index] = {
        ...item,
        toolName: item.toolName === '' ? event.toolName : item.toolName,
        status: event.isError ? 'error' : 'ok',
        result: event.content,
        durationMs: event.durationMs,
        // The input is complete exactly now, so this is the one moment it parses.
        affectedPaths: extractPaths(item.inputJson),
      };
      return;
    }

    case 'permission_request': {
      buffer.pendingPermissions = [
        ...buffer.pendingPermissions,
        {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          affectedPaths: event.affectedPaths,
          defaultPolicy: event.defaultPolicy,
        },
      ];
      return;
    }

    case 'plan_update': {
      const existing = itemAt(buffer, buffer.planIndex);
      if (existing !== undefined && existing.kind === 'plan') {
        buffer.items[buffer.planIndex] = { ...existing, steps: event.steps };
        return;
      }
      buffer.planIndex = buffer.items.length;
      buffer.items.push({ kind: 'plan', id: nextId(buffer, 'plan'), steps: event.steps });
      return;
    }

    case 'file_edit_proposed': {
      closeAssistant(buffer);
      const isNewFile = event.beforeHash === undefined;
      buffer.items.push({
        kind: 'file_edit',
        id: nextId(buffer, 'edit'),
        path: event.path,
        summary: describeEdit(event.afterContent, isNewFile),
        isNewFile,
      });
      return;
    }

    case 'usage': {
      buffer.usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
      };
      return;
    }

    case 'error': {
      closeAssistant(buffer);
      closeThinking(buffer);
      buffer.lastError = event.message;
      buffer.items.push({
        kind: 'error',
        id: nextId(buffer, 'error'),
        message: event.message,
        code: event.code,
        retryable: event.retryable,
      });
      return;
    }

    case 'turn_end': {
      closeAssistant(buffer);
      closeThinking(buffer);
      buffer.busy = false;
      // A turn cannot end while a permission still blocks it — the SDK's `canUseTool`
      // promise had to settle first. Retiring here is what makes replay safe: the
      // union carries no resolution event, so historical prompts would otherwise
      // resurrect as live ones every time a session is reopened.
      if (buffer.pendingPermissions.length > 0) {
        buffer.pendingPermissions = [];
      }
      return;
    }

    default:
      return assertNever(event);
  }
}

/** Retires one prompt by id, for the host's `permission_resolved` echo. */
export function resolvePermission(buffer: TranscriptBuffer, requestId: string): void {
  buffer.pendingPermissions = buffer.pendingPermissions.filter(
    (pending) => pending.requestId !== requestId,
  );
}

/**
 * Records a submitted prompt. The event union has no user-message member, so the
 * echo is local — and therefore absent from a replayed history (see the report).
 */
export function appendUserPrompt(buffer: TranscriptBuffer, text: string): void {
  closeAssistant(buffer);
  buffer.items.push({ kind: 'user', id: nextId(buffer, 'user'), text });
}

/**
 * Records a host-side failure in the transcript rather than only in a banner. A
 * failure that happened at a point in the conversation belongs at that point: a
 * banner above the scrollback says something broke but never says when.
 */
export function appendHostError(buffer: TranscriptBuffer, message: string): void {
  closeAssistant(buffer);
  buffer.lastError = message;
  buffer.items.push({
    kind: 'error',
    id: nextId(buffer, 'error'),
    message,
    code: 'host_error',
    retryable: false,
  });
}

/** Rebuilds a buffer from a persisted event log, through the same reducer. */
export function replayTranscript(history: readonly AgentEvent[]): TranscriptBuffer {
  const buffer = createTranscript();
  for (const event of history) {
    applyAgentEvent(buffer, event);
  }
  return buffer;
}
