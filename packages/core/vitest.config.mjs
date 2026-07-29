import { defineConfig } from 'vitest/config';

// Plain Node, no editor harness. This is the payoff of the dependency rule in
// Docs/TARS_SPEC.md §3.1 — everything in core is testable without VS Code.
//
// Authored as .mjs rather than .ts because a build script outside the package's
// `rootDir` belongs to no TypeScript project, and the repo lints with
// `projectService`, which requires every linted .ts file to be in one.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
