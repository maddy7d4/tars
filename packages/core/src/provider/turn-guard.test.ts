import { toSessionId, toTurnId } from '@tars/shared';
import type { AgentEvent, SessionId, TurnId } from '@tars/shared';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../testing/fakes.js';
import { TurnGuard } from './turn-guard.js';
import type { TurnEndReason } from './turn-guard.js';

const sessionId: SessionId = toSessionId('session-1');
const turnId: TurnId = toTurnId('turn-1');

/** Guard plus the clock stamping it, so a test can advance time between calls. */
function makeGuard(): { guard: TurnGuard; clock: FakeClock } {
  const clock = new FakeClock(1_000);
  const guard = new TurnGuard({ sessionId, turnId, now: () => clock.now() });
  return { guard, clock };
}

/** An event the guard has no special handling for, used to probe the prefix logic. */
function textDelta(at: number, text = 'hello'): AgentEvent {
  return { type: 'text_delta', text, sessionId, turnId, at };
}

/** Every `TurnEndEvent['reason']`; the array is typed so a new variant breaks compilation. */
const allReasons: readonly TurnEndReason[] = ['completed', 'interrupted', 'error', 'max_turns'];

describe('TurnGuard', () => {
  describe('lifecycle', () => {
    it('emits exactly one turn_start on begin', () => {
      const { guard } = makeGuard();

      expect(guard.begin()).toEqual([{ type: 'turn_start', sessionId, turnId, at: 1_000 }]);
      expect(guard.isEnded).toBe(false);
    });

    it('emits nothing on a second begin', () => {
      const { guard } = makeGuard();

      guard.begin();

      expect(guard.begin()).toEqual([]);
    });

    it('closes an opened turn with turn_end and flips isEnded', () => {
      const { guard } = makeGuard();

      guard.begin();

      expect(guard.end('completed')).toEqual([
        { type: 'turn_end', reason: 'completed', sessionId, turnId, at: 1_000 },
      ]);
      expect(guard.isEnded).toBe(true);
    });

    it('synthesizes turn_start when end is reached without begin', () => {
      const { guard } = makeGuard();

      expect(guard.end('error')).toEqual([
        { type: 'turn_start', sessionId, turnId, at: 1_000 },
        { type: 'turn_end', reason: 'error', sessionId, turnId, at: 1_000 },
      ]);
    });

    it('synthesizes turn_start ahead of the first passed event', () => {
      const { guard } = makeGuard();
      const event = textDelta(1_000);

      expect(guard.pass(event)).toEqual([
        { type: 'turn_start', sessionId, turnId, at: 1_000 },
        event,
      ]);
      expect(guard.pass(textDelta(1_000, 'more'))).toEqual([textDelta(1_000, 'more')]);
    });
  });

  describe('turn boundary ownership', () => {
    it('drops an adapter-produced turn_start', () => {
      const { guard } = makeGuard();
      guard.begin();

      const adapterStart: AgentEvent = { type: 'turn_start', sessionId, turnId, at: 1_000 };

      expect(guard.pass(adapterStart)).toEqual([]);
    });

    it('drops an adapter-produced turn_end and leaves the turn open', () => {
      const { guard } = makeGuard();
      guard.begin();

      const adapterEnd: AgentEvent = {
        type: 'turn_end',
        reason: 'completed',
        sessionId,
        turnId,
        at: 1_000,
      };

      expect(guard.pass(adapterEnd)).toEqual([]);
      expect(guard.isEnded).toBe(false);
      expect(guard.end('completed')).toEqual([
        { type: 'turn_end', reason: 'completed', sessionId, turnId, at: 1_000 },
      ]);
    });

    it('opens the turn even when the first event is one it drops', () => {
      const { guard } = makeGuard();

      const adapterEnd: AgentEvent = {
        type: 'turn_end',
        reason: 'completed',
        sessionId,
        turnId,
        at: 1_000,
      };

      expect(guard.pass(adapterEnd)).toEqual([
        { type: 'turn_start', sessionId, turnId, at: 1_000 },
      ]);
    });
  });

  describe('thinking blocks', () => {
    it('passes a matched thinking_start / thinking_end pair through untouched', () => {
      const { guard } = makeGuard();
      guard.begin();

      const start: AgentEvent = { type: 'thinking_start', sessionId, turnId, at: 1_000 };
      const end: AgentEvent = { type: 'thinking_end', sessionId, turnId, at: 1_000 };

      expect(guard.pass(start)).toEqual([start]);
      expect(guard.pass(end)).toEqual([end]);
    });

    it('drops a duplicate thinking_start', () => {
      const { guard } = makeGuard();
      guard.begin();

      const start: AgentEvent = { type: 'thinking_start', sessionId, turnId, at: 1_000 };
      guard.pass(start);

      expect(guard.pass(start)).toEqual([]);
    });

    it('drops a thinking_end with no open block', () => {
      const { guard } = makeGuard();
      guard.begin();

      const end: AgentEvent = { type: 'thinking_end', sessionId, turnId, at: 1_000 };

      expect(guard.pass(end)).toEqual([]);
    });

    it('synthesizes thinking_start ahead of an orphan thinking_delta', () => {
      const { guard } = makeGuard();
      guard.begin();

      const delta: AgentEvent = { type: 'thinking_delta', text: 'hmm', sessionId, turnId, at: 1_000 };

      expect(guard.pass(delta)).toEqual([
        { type: 'thinking_start', sessionId, turnId, at: 1_000 },
        delta,
      ]);
      // The block is now open, so the next delta needs no synthesis.
      expect(guard.pass(delta)).toEqual([delta]);
    });

    it('closes an outstanding thinking block before turn_end', () => {
      const { guard } = makeGuard();
      guard.begin();
      guard.pass({ type: 'thinking_start', sessionId, turnId, at: 1_000 });

      expect(guard.end('interrupted')).toEqual([
        { type: 'thinking_end', sessionId, turnId, at: 1_000 },
        { type: 'turn_end', reason: 'interrupted', sessionId, turnId, at: 1_000 },
      ]);
    });

    it('does not synthesize a thinking_end for a block that already closed', () => {
      const { guard } = makeGuard();
      guard.begin();
      guard.pass({ type: 'thinking_start', sessionId, turnId, at: 1_000 });
      guard.pass({ type: 'thinking_end', sessionId, turnId, at: 1_000 });

      expect(guard.end('completed')).toEqual([
        { type: 'turn_end', reason: 'completed', sessionId, turnId, at: 1_000 },
      ]);
    });
  });

  describe('end reasons', () => {
    it.each(allReasons)('reports reason %s verbatim', (reason) => {
      const { guard } = makeGuard();
      guard.begin();

      expect(guard.end(reason)).toEqual([
        { type: 'turn_end', reason, sessionId, turnId, at: 1_000 },
      ]);
    });

    it.each(allReasons)('closes an open thinking block when ending with %s', (reason) => {
      const { guard } = makeGuard();
      guard.pass({ type: 'thinking_delta', text: 'x', sessionId, turnId, at: 1_000 });

      expect(guard.end(reason)).toEqual([
        { type: 'thinking_end', sessionId, turnId, at: 1_000 },
        { type: 'turn_end', reason, sessionId, turnId, at: 1_000 },
      ]);
    });
  });

  describe('idempotency after end', () => {
    it('emits nothing on a second end and keeps the first reason', () => {
      const { guard } = makeGuard();
      guard.begin();
      const first = guard.end('completed');

      expect(guard.end('error')).toEqual([]);
      expect(guard.end('interrupted')).toEqual([]);
      expect(first).toEqual([
        { type: 'turn_end', reason: 'completed', sessionId, turnId, at: 1_000 },
      ]);
      expect(guard.isEnded).toBe(true);
    });

    it('drops every event passed after the turn ended', () => {
      const { guard } = makeGuard();
      guard.begin();
      guard.end('completed');

      expect(guard.pass(textDelta(1_000))).toEqual([]);
      expect(guard.pass({ type: 'thinking_start', sessionId, turnId, at: 1_000 })).toEqual([]);
      expect(guard.pass({ type: 'thinking_delta', text: 'x', sessionId, turnId, at: 1_000 })).toEqual(
        [],
      );
    });

    it('does not re-open the turn via begin after end', () => {
      const { guard } = makeGuard();
      guard.end('error');

      expect(guard.begin()).toEqual([]);
      expect(guard.isEnded).toBe(true);
    });
  });

  describe('interrupt and error paths', () => {
    it('ends a turn interrupted mid-thinking with a complete, well-formed tail', () => {
      const { guard } = makeGuard();
      const emitted: AgentEvent[] = [
        ...guard.pass({ type: 'thinking_delta', text: 'plan', sessionId, turnId, at: 1_000 }),
        ...guard.end('interrupted'),
      ];

      expect(emitted.map((event) => event.type)).toEqual([
        'turn_start',
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'turn_end',
      ]);
    });

    it('still closes the turn when the stream fails after an error event', () => {
      const { guard } = makeGuard();
      const error: AgentEvent = {
        type: 'error',
        message: 'transport closed',
        code: 'ECONN',
        retryable: true,
        sessionId,
        turnId,
        at: 1_000,
      };

      expect(guard.pass(error)).toEqual([
        { type: 'turn_start', sessionId, turnId, at: 1_000 },
        error,
      ]);
      expect(guard.end('error')).toEqual([
        { type: 'turn_end', reason: 'error', sessionId, turnId, at: 1_000 },
      ]);
    });
  });

  describe('timestamps', () => {
    it('stamps every synthesized event from the injected clock', () => {
      const { guard, clock } = makeGuard();

      const [start] = guard.begin();
      clock.advance(5);
      guard.pass({ type: 'thinking_start', sessionId, turnId, at: 0 });
      clock.advance(7);
      const closing = guard.end('completed');

      expect(start).toEqual({ type: 'turn_start', sessionId, turnId, at: 1_000 });
      expect(closing).toEqual([
        { type: 'thinking_end', sessionId, turnId, at: 1_012 },
        { type: 'turn_end', reason: 'completed', sessionId, turnId, at: 1_012 },
      ]);
    });

    it('stamps a synthesized thinking_start at the moment the delta arrived', () => {
      const { guard, clock } = makeGuard();
      guard.begin();
      clock.advance(42);

      const delta: AgentEvent = { type: 'thinking_delta', text: 'x', sessionId, turnId, at: 0 };

      expect(guard.pass(delta)).toEqual([
        { type: 'thinking_start', sessionId, turnId, at: 1_042 },
        delta,
      ]);
    });

    it('leaves an adapter event’s own timestamp untouched', () => {
      const { guard, clock } = makeGuard();
      guard.begin();
      clock.advance(100);

      const event = textDelta(7);

      expect(guard.pass(event)).toEqual([{ type: 'text_delta', text: 'hello', sessionId, turnId, at: 7 }]);
    });
  });
});
