import type { SessionId, TurnId } from './brand.js';

/** Stable identifier for one tool invocation within a turn. */
export type ToolCallId = string;

/** Per-tool decision policy (Docs/TARS_SPEC.md §4.2). */
export type PermissionPolicy = 'always_allow' | 'ask' | 'deny';

/** Fields every normalized event carries, so consumers can route without narrowing first. */
export interface AgentEventBase {
  /** The session that produced the event. */
  readonly sessionId: SessionId;
  /** The user turn being answered. */
  readonly turnId: TurnId;
  /** Milliseconds since epoch, supplied by `ClockPort` so tests are deterministic. */
  readonly at: number;
}

/**
 * The turn has begun. Exactly one is emitted per turn, before any other event.
 *
 * Explicit rather than inferred from the first `text_delta`: a turn may legitimately
 * open with thinking, a tool call, or a permission request, so "first event of any
 * kind" is not a usable start signal. Consumers reset per-turn state here.
 */
export interface TurnStartEvent extends AgentEventBase {
  readonly type: 'turn_start';
}

/** A chunk of assistant prose. Appended to the current message; never a whole message. */
export interface TextDeltaEvent extends AgentEventBase {
  readonly type: 'text_delta';
  readonly text: string;
}

/** The model began an extended-thinking block. Emitted once before its deltas. */
export interface ThinkingStartEvent extends AgentEventBase {
  readonly type: 'thinking_start';
}

/** A chunk of extended-thinking content, rendered collapsed by default. */
export interface ThinkingDeltaEvent extends AgentEventBase {
  readonly type: 'thinking_delta';
  readonly text: string;
}

/**
 * The extended-thinking block closed. Emitted once per `thinking_start`.
 *
 * Explicit rather than inferred from the arrival of a non-thinking event: Claude
 * interleaves thinking with tool calls, so a `tool_call_start` does not imply the
 * thinking block ended — it may resume. Without a terminator the UI cannot tell
 * "still thinking, paused for a tool" from "done thinking", and a collapsed
 * thinking panel would either never close or close too early.
 */
export interface ThinkingEndEvent extends AgentEventBase {
  readonly type: 'thinking_end';
}

/** A tool invocation has begun. Arguments may still be streaming in. */
export interface ToolCallStartEvent extends AgentEventBase {
  readonly type: 'tool_call_start';
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
}

/**
 * A fragment of a tool's input, as JSON text. Kept as text rather than a parsed
 * object because partial JSON is not parseable — the UI shows progress, the
 * adapter parses only once the call closes.
 */
export interface ToolCallDeltaEvent extends AgentEventBase {
  readonly type: 'tool_call_delta';
  readonly toolCallId: ToolCallId;
  readonly inputJsonDelta: string;
}

/** A tool finished. `isError` distinguishes a tool-reported failure from a transport failure. */
export interface ToolCallResultEvent extends AgentEventBase {
  readonly type: 'tool_call_result';
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly isError: boolean;
  readonly content: string;
  readonly durationMs: number;
}

/**
 * The agent wants to run a gated tool and is blocked until the user decides.
 * Maps onto the SDK's `canUseTool` hook (Docs/TARS_SPEC.md §4.2).
 */
export interface PermissionRequestEvent extends AgentEventBase {
  readonly type: 'permission_request';
  readonly requestId: string;
  readonly toolName: string;
  /** Rendered verbatim for review; the shape is tool-specific and not ours to interpret. */
  readonly input: JsonValue;
  /** Workspace-relative paths the invocation would touch, when derivable. */
  readonly affectedPaths: readonly string[];
  readonly defaultPolicy: PermissionPolicy;
}

/** The agent's task list changed. Always the complete list, never a patch. */
export interface PlanUpdateEvent extends AgentEventBase {
  readonly type: 'plan_update';
  readonly steps: readonly PlanStep[];
}

/** One entry in the agent's plan. */
export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

/**
 * An edit the agent proposes for a file. Accumulated into a `ChangeSet` in core
 * and reviewed in the native diff editor (Docs/TARS_SPEC.md §6).
 */
export interface FileEditProposedEvent extends AgentEventBase {
  readonly type: 'file_edit_proposed';
  readonly path: string;
  /** SHA-256 of the on-disk content the edit was computed against; absent for a new file. */
  readonly beforeHash?: string;
  readonly afterContent: string;
}

/** Token accounting for the turn so far. Cumulative, not incremental. */
export interface UsageEvent extends AgentEventBase {
  readonly type: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** A failure that ended or degraded the turn. `retryable` drives whether the UI offers a retry. */
export interface ErrorEvent extends AgentEventBase {
  readonly type: 'error';
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
}

/** The turn is complete. Exactly one is emitted per turn, including after an error. */
export interface TurnEndEvent extends AgentEventBase {
  readonly type: 'turn_end';
  readonly reason: 'completed' | 'interrupted' | 'error' | 'max_turns';
}

/**
 * The single normalized event union every provider maps its native stream onto
 * (Docs/TARS_SPEC.md §4.1). Neither core orchestration nor the React UI ever
 * sees a provider SDK type, so an SDK upgrade touches one adapter file.
 */
export type AgentEvent =
  | TurnStartEvent
  | TextDeltaEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallResultEvent
  | PermissionRequestEvent
  | PlanUpdateEvent
  | FileEditProposedEvent
  | UsageEvent
  | ErrorEvent
  | TurnEndEvent;

/** Discriminant values of `AgentEvent`, useful for routing tables. */
export type AgentEventType = AgentEvent['type'];

/** JSON that survives `postMessage` structured cloning and JSONL persistence. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
