import type {
  NonNullableUsage,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentQuery } from './session.js';

/**
 * Hand-built `SDKMessage` fixtures and a fake `AgentQuery`.
 *
 * Every builder's return type is the SDK's own declared type, which is the point:
 * if the SDK renames or reshapes a field, this file stops compiling under
 * `pnpm typecheck` and the adapter tests fail loudly, instead of continuing to
 * pass against a fixture that no longer resembles the real stream. ADR 0004 makes
 * adapter tests mandatory precisely because a mapping defect surfaces far from its
 * cause; a fixture that has silently drifted would defeat them.
 *
 * Lives inside `provider/claude-code/` because it is the only directory permitted
 * to reference SDK types (Docs/TARS_SPEC.md §4.1).
 */

const SESSION = 'fixture-session';

/** A `NonNullableUsage`, which the `result` message requires in full. */
export function usage(
  overrides: Partial<Pick<
    NonNullableUsage,
    'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  >> = {},
): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: { status: { type: 'redeemed' } },
    inference_geo: 'unknown',
    input_tokens: 0,
    iterations: [],
    output_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
    ...overrides,
  };
}

function partial(
  event: SDKPartialAssistantMessage['event'],
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

/** `message_start`, which resets streaming content-block indices. */
export function messageStart(): SDKMessage {
  return partial({
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      container: null,
      content: [],
      context_management: null,
      diagnostics: null,
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: usage(),
    },
  });
}

export function textBlockStart(index: number): SDKMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '', citations: null },
  });
}

export function textDelta(index: number, text: string): SDKMessage {
  return partial({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
}

export function thinkingBlockStart(index: number): SDKMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  });
}

export function thinkingDelta(index: number, thinking: string): SDKMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking, estimated_tokens: null },
  });
}

export function toolUseBlockStart(index: number, id: string, name: string): SDKMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
}

export function inputJsonDelta(index: number, partialJson: string): SDKMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });
}

export function signatureDelta(index: number, signature: string): SDKMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
  });
}

export function blockStop(index: number): SDKMessage {
  return partial({ type: 'content_block_stop', index });
}

export function messageStop(): SDKMessage {
  return partial({ type: 'message_stop' });
}

/** A completed assistant message. Its tool_use blocks carry fully parsed input. */
export function assistantMessage(
  content: SDKAssistantMessage['message']['content'],
  error?: SDKAssistantMessage['error'],
): SDKMessage {
  const message: SDKAssistantMessage = {
    type: 'assistant',
    message: {
      id: 'msg_fixture',
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: usage(),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: SESSION,
    ...(error !== undefined ? { error } : {}),
  };
  return message;
}

/** A user message carrying one tool result, as the SDK delivers tool outcomes. */
export function toolResultMessage(
  toolUseId: string,
  content: string,
  isError = false,
): SDKMessage {
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: SESSION,
  };
  return message;
}

export function successResult(
  overrides: Parameters<typeof usage>[0] = {},
): SDKMessage {
  const message: SDKResultMessage = {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: usage(overrides),
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: SESSION,
  };
  return message;
}

export function errorResult(
  subtype: Exclude<SDKResultMessage['subtype'], 'success'>,
  errors: readonly string[] = [],
): SDKMessage {
  const message: SDKResultMessage = {
    type: 'result',
    subtype,
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: usage(),
    modelUsage: {},
    permission_denials: [],
    errors: [...errors],
    uuid: randomUUID(),
    session_id: SESSION,
  };
  return message;
}

/** The `system`/`init` message, which carries session metadata and no turn content. */
export function initMessage(): SDKMessage {
  const message: SDKSystemMessage = {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'oauth',
    claude_code_version: '0.0.0-fixture',
    cwd: '/workspace',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    model: 'claude-opus-4-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: SESSION,
  };
  return message;
}

/** A tool the SDK denied itself, without ever calling `canUseTool`. */
export function permissionDeniedMessage(toolName: string, reason: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: toolName,
    tool_use_id: 'toolu_denied',
    message: reason,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

/** How a scripted stream ends once its messages are exhausted. */
export type StreamEnding =
  | { readonly kind: 'complete' }
  | { readonly kind: 'throw'; readonly error: Error }
  | { readonly kind: 'hang' };

/**
 * A fake `AgentQuery` over a scripted message list.
 *
 * `hang` exists to test interrupt and dispose honestly: a stream that ends by
 * itself would satisfy the turn invariants for the wrong reason, so the
 * interesting cases are the ones where the turn only ends because TARS ended it.
 */
export class FakeQuery implements AgentQuery {
  interruptCalls = 0;
  closeCalls = 0;

  private release: (() => void) | null = null;
  private interruptError: Error | null = null;

  constructor(
    private readonly messages: readonly SDKMessage[],
    private readonly ending: StreamEnding = { kind: 'complete' },
  ) {}

  /** Makes `interrupt()` reject, exercising the failed-interrupt path. */
  failInterruptWith(error: Error): void {
    this.interruptError = error;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (const message of this.messages) {
      // Yielding to the microtask queue between messages lets the consumer observe
      // events incrementally, which is what a real stream does.
      await Promise.resolve();
      yield message;
    }
    if (this.ending.kind === 'throw') {
      throw this.ending.error;
    }
    if (this.ending.kind === 'hang') {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  interrupt(): Promise<unknown> {
    this.interruptCalls += 1;
    if (this.interruptError !== null) {
      return Promise.reject(this.interruptError);
    }
    this.releaseHang();
    return Promise.resolve(undefined);
  }

  close(): void {
    this.closeCalls += 1;
    this.releaseHang();
  }

  private releaseHang(): void {
    const release = this.release;
    if (release !== null) {
      this.release = null;
      release();
    }
  }
}
