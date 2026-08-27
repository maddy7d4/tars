import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Testing Library only self-registers cleanup when `afterEach` is a global, and
 * this suite runs without vitest globals.
 *
 * Deliberately imports nothing from `src/` besides Testing Library. Setup files
 * are evaluated before the test file, so anything imported here is already in the
 * module cache — with its real dependencies — by the time that file's `vi.mock`
 * calls are registered, and the mock silently never takes effect. Store resets
 * therefore belong in each suite's own `beforeEach`.
 */
afterEach(() => {
  cleanup();
});
