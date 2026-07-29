import type { ClockPort } from '@tars/core';

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
