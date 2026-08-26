import type { AgentEvent, SessionId, TurnEndEvent, TurnId } from '@tars/shared';

/** Why a turn stopped. Narrowed from the union member so callers cannot drift. */
export type TurnEndReason = TurnEndEvent['reason'];

/** Everything the guard needs to stamp a synthesized event. */
export interface TurnGuardContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** Injected so ordering assertions are exact against a fake clock (§3.2). */
  readonly now: () => number;
}

/**
 * Enforces the turn and thinking-block invariants of Docs/TARS_SPEC.md §4.1 on a
 * per-turn basis, independently of the provider stream's shape.
 *
 * The invariants are:
 *
 * - exactly one `turn_start`, before any other event in the turn;
 * - exactly one `turn_end`, including when the turn ends by error or interrupt;
 * - every `thinking_start` is matched by exactly one `thinking_end`.
 *
 * Placing this in front of the adapter rather than trusting the SDK stream is
 * deliberate. The SDK can end a turn without closing a thinking block — an abort
 * mid-block, a transport failure, a `stop_reason` arriving between
 * `content_block_start` and `content_block_stop` — and ADR 0004 records why an
 * unterminated thinking block is a UI defect rather than a cosmetic one: a
 * collapsed thinking panel that never closes. Making the invariant structural
 * means no consumer has to defend against a malformed stream.
 *
 * Provider-agnostic on purpose: it holds no SDK types, so it is the same guard for
 * any future provider and is testable without one.
 */
export class TurnGuard {
  private started = false;
  private ended = false;
  private thinkingOpen = false;

  constructor(private readonly ctx: TurnGuardContext) {}

  get isEnded(): boolean {
    return this.ended;
  }

  /** `turn_start`, or nothing on a second call. */
  begin(): readonly AgentEvent[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [{ type: 'turn_start', ...this.stamp() }];
  }

  /**
   * Normalizes one adapter-produced event. Returns zero or more events because a
   * `thinking_delta` arriving without an open block has to be preceded by a
   * synthesized `thinking_start`, and a duplicate terminator has to be dropped.
   */
  pass(event: AgentEvent): readonly AgentEvent[] {
    if (this.ended) {
      // After `turn_end` the turn is closed for good; a trailing event would make
      // `turn_end` no longer mean "the turn is complete".
      return [];
    }

    const prefix = this.begin();

    switch (event.type) {
      case 'thinking_start':
        if (this.thinkingOpen) {
          return prefix;
        }
        this.thinkingOpen = true;
        return [...prefix, event];

      case 'thinking_delta':
        if (this.thinkingOpen) {
          return [...prefix, event];
        }
        this.thinkingOpen = true;
        return [...prefix, { type: 'thinking_start', ...this.stamp() }, event];

      case 'thinking_end':
        if (!this.thinkingOpen) {
          return prefix;
        }
        this.thinkingOpen = false;
        return [...prefix, event];

      case 'turn_start':
      case 'turn_end':
        // The turn boundary belongs to this guard alone. An adapter that emitted
        // one would break the "exactly one" guarantee it exists to provide.
        return prefix;

      default:
        return [...prefix, event];
    }
  }

  /**
   * Closes the turn: an outstanding `thinking_end` first, then `turn_end`.
   * Idempotent, so the several paths that can end a turn — a `result` message, a
   * resolved interrupt, a stream failure, `dispose` — may all call it and the
   * first one wins.
   */
  end(reason: TurnEndReason): readonly AgentEvent[] {
    if (this.ended) {
      return [];
    }
    const prefix = this.begin();
    this.ended = true;

    const closing: AgentEvent[] = [...prefix];
    if (this.thinkingOpen) {
      this.thinkingOpen = false;
      closing.push({ type: 'thinking_end', ...this.stamp() });
    }
    closing.push({ type: 'turn_end', reason, ...this.stamp() });
    return closing;
  }

  private stamp(): { sessionId: SessionId; turnId: TurnId; at: number } {
    return { sessionId: this.ctx.sessionId, turnId: this.ctx.turnId, at: this.ctx.now() };
  }
}
