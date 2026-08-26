/**
 * A single-consumer, unbounded async queue.
 *
 * `AgentSession.events` is declared as a single-consumer `AsyncIterable`
 * (Docs/TARS_SPEC.md §4): two independent consumers of one stream would each see
 * half the deltas. This queue is the mechanism — producers call `push` from
 * anywhere (the SDK pump, the permission broker, the turn guard) and the single
 * consumer drives it with `for await`.
 *
 * Unbounded is deliberate. Dropping or coalescing `text_delta` events to bound
 * memory would corrupt the transcript, and the consumer is a local in-process
 * fan-out that keeps up with a token stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** Ignored after `close`, so a late producer cannot resurrect a finished stream. */
  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  /**
   * Completes the iterator once buffered values are drained. Idempotent: `dispose`
   * is specified as idempotent and reaches this on every call.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Values pushed but not yet consumed. Exposed so tests can assert nothing leaks. */
  get pending(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Length-checked rather than testing `shift()` for undefined, so a queue of
        // a nullable T cannot mistake a real value for an empty buffer.
        if (this.buffer.length > 0) {
          const [buffered] = this.buffer.splice(0, 1) as [T];
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
      // Called when the consumer breaks out of `for await`. Closing here is what
      // stops a pending `next()` promise from being retained forever.
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        this.buffer.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
