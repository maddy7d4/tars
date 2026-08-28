import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Builds the integration suite.
 *
 * Separate from `esbuild.mjs` because the outputs are unrelated: that one
 * produces the single bundle VS Code loads, this one produces three CommonJS
 * files a test runner loads. Bundling them together would ship Mocha in the
 * `.vsix`.
 *
 * Each entry point stays its own file rather than one bundle: VS Code requires
 * `extensionTestsPath` as a module and Mocha requires the test file separately,
 * so they cannot be a single artefact.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'out', 'test');

await esbuild.build({
  entryPoints: [
    resolve(here, 'test', 'run-tests.ts'),
    resolve(here, 'test', 'suite', 'index.ts'),
    resolve(here, 'test', 'suite', 'extension.test.ts'),
  ],
  outdir: outDir,
  outbase: resolve(here, 'test'),
  bundle: true,
  platform: 'node',
  // `.cjs` rather than `.js`: the package is `"type": "module"`, so a bare `.js`
  // here would be loaded as ESM and `require` would not exist.
  outExtension: { '.js': '.cjs' },
  format: 'cjs',
  target: 'node20',
  // Supplied by the editor at runtime; and Mocha and the launcher are ordinary
  // dependencies that must not be inlined into a file Mocha itself loads.
  external: ['vscode', 'mocha', '@vscode/test-electron'],
  sourcemap: 'inline',
  logLevel: 'info',
});
