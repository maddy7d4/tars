import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './async-queue.js';

/**
 * Everything here is driven by promise resolution alone — no timers, no sleeps.
 * `next()` installs its waiter synchronously and `push` resolves that waiter
 * synchronously, so a test can observe the wake-up path without racing a clock.
 */

/** Drains an iterable into an array. Terminates only once the queue closes. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of source) {
    collected.push(value);
  }
  return collected;
}

describe('AsyncQueue', () => {
  describe('FIFO delivery', () => {
    it('yields values pushed before consumption, in order', async () => {
      const queue = new AsyncQueue<number>();

      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.close();

      expect(await drain(queue)).toEqual([1, 2, 3]);
    });

    it('delivers to a for-await consumer that started before any push', async () => {
      const queue = new AsyncQueue<string>();
      const consumed = drain(queue);

      queue.push('a');
      queue.push('b');
      queue.close();

      expect(await consumed).toEqual(['a', 'b']);
    });

    it('wakes a pending next() synchronously on push, without buffering', async () => {
      const queue = new AsyncQueue<string>();
      const iterator = queue[Symbol.asyncIterator]();

      // `next()` registers the waiter before returning, so the queue is now parked.
      const pending = iterator.next();
      expect(queue.pending).toBe(0);

      queue.push('woken');

      // Handed straight to the waiter rather than through the buffer.
      expect(queue.pending).toBe(0);
      expect(await pending).toEqual({ value: 'woken', done: false });
    });

    it('parks again after each wake-up', async () => {
      const queue = new AsyncQueue<number>();
      const iterator = queue[Symbol.asyncIterator]();

      const first = iterator.next();
      queue.push(10);
      expect(await first).toEqual({ value: 10, done: false });

      const second = iterator.next();
      queue.push(20);
      expect(await second).toEqual({ value: 20, done: false });

      expect(queue.pending).toBe(0);
    });

    it('preserves nullable values rather than mistaking them for an empty buffer', async () => {
      const queue = new AsyncQueue<string | null | undefined>();

      queue.push(null);
      queue.push(undefined);
      queue.push('tail');
      queue.close();

      expect(await drain(queue)).toEqual([null, undefined, 'tail']);
    });
  });

  describe('buffering', () => {
    it('is unbounded: every push before consumption is retained', async () => {
      const queue = new AsyncQueue<number>();
      const values = Array.from({ length: 1_000 }, (_unused, index) => index);

      for (const value of values) {
        queue.push(value);
      }

      expect(queue.pending).toBe(1_000);
      queue.close();
      expect(await drain(queue)).toEqual(values);
      expect(queue.pending).toBe(0);
    });

    it('drops the buffer count as values are taken', async () => {
      const queue = new AsyncQueue<string>();
      const iterator = queue[Symbol.asyncIterator]();

      queue.push('x');
      queue.push('y');
      expect(queue.pending).toBe(2);

      expect(await iterator.next()).toEqual({ value: 'x', done: false });
      expect(queue.pending).toBe(1);
      expect(await iterator.next()).toEqual({ value: 'y', done: false });
      expect(queue.pending).toBe(0);
    });
  });

  describe('close', () => {
    it('drains values pushed before close, then terminates', async () => {
      const queue = new AsyncQueue<string>();

      queue.push('before');
      queue.close();

      expect(queue.isClosed).toBe(true);
      expect(await drain(queue)).toEqual(['before']);
    });

    it('resolves a parked consumer as done', async () => {
      const queue = new AsyncQueue<string>();
      const iterator = queue[Symbol.asyncIterator]();

      const pending = iterator.next();
      queue.close();

      expect(await pending).toEqual({ value: undefined, done: true });
    });

    it('terminates a for-await consumer that was parked when close arrived', async () => {
      const queue = new AsyncQueue<string>();
      const consumed = drain(queue);

      queue.close();

      expect(await consumed).toEqual([]);
    });

    it('is idempotent', async () => {
      const queue = new AsyncQueue<string>();

      queue.close();
      queue.close();
      queue.close();

      expect(queue.isClosed).toBe(true);
      expect(await drain(queue)).toEqual([]);
    });

    it('ignores a push after close, so a late producer cannot resurrect the stream', async () => {
      const queue = new AsyncQueue<string>();

      queue.push('kept');
      queue.close();
      queue.push('dropped');

      expect(queue.pending).toBe(1);
      expect(await drain(queue)).toEqual(['kept']);
    });

    it('reports done on every next() after the buffer is drained', async () => {
      const queue = new AsyncQueue<string>();
      const iterator = queue[Symbol.asyncIterator]();

      queue.push('only');
      queue.close();

      expect(await iterator.next()).toEqual({ value: 'only', done: false });
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });
  });

  describe('early consumer exit', () => {
    it('closes the queue and discards the buffer when the consumer breaks out', async () => {
      const queue = new AsyncQueue<number>();

      queue.push(1);
      queue.push(2);
      queue.push(3);

      const seen: number[] = [];
      for await (const value of queue) {
        seen.push(value);
        if (value === 1) {
          break;
        }
      }

      expect(seen).toEqual([1]);
      expect(queue.isClosed).toBe(true);
      expect(queue.pending).toBe(0);
    });

    it('leaves no retained waiter after an explicit return()', async () => {
      const queue = new AsyncQueue<number>();
      const iterator = queue[Symbol.asyncIterator]();

      const pending = iterator.next();
      // `return` closes, which resolves the parked waiter rather than orphaning it.
      const returned = iterator.return?.();

      expect(await pending).toEqual({ value: undefined, done: true });
      expect(await returned).toEqual({ value: undefined, done: true });
      expect(queue.isClosed).toBe(true);
    });

    it('yields nothing further once the consumer has returned', async () => {
      const queue = new AsyncQueue<number>();
      const iterator = queue[Symbol.asyncIterator]();

      queue.push(1);
      await iterator.return?.();
      queue.push(2);

      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      expect(queue.pending).toBe(0);
    });
  });

  describe('error propagation', () => {
    it('has no error channel: failures are modelled as values, not iterator rejections', async () => {
      // The queue deliberately exposes no `fail`/`throw` path — the event pipeline
      // carries failures as `error` events so the stream still ends cleanly.
      const queue = new AsyncQueue<{ kind: 'error'; message: string } | { kind: 'text' }>();
      const iterator = queue[Symbol.asyncIterator]();

      // `in` rather than a property read: asserting the channel's absence must not
      // reference the method itself (@typescript-eslint/unbound-method).
      expect('throw' in iterator).toBe(false);

      queue.push({ kind: 'error', message: 'boom' });
      queue.close();

      expect(await drain(queue)).toEqual([{ kind: 'error', message: 'boom' }]);
    });
  });
});
