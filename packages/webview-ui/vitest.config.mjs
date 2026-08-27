import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Authored as .mjs for the same reason as vite.config.mjs: a build script outside
// the package's `rootDir` belongs to no TypeScript project, and the repo lints with
// `projectService`, which requires every linted .ts file to be in one.
export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom over jsdom: the transcript exercises scroll geometry and focus, not
    // canvas or navigation, and happy-dom starts in a fraction of the time.
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
