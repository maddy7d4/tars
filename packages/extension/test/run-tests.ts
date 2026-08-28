import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Downloads a real VS Code and runs the integration suite inside it
 * (Docs/TARS_SPEC.md §8.1).
 *
 * This layer exists for the things a fake cannot answer: whether the manifest
 * actually activates, whether every contributed command is registered, whether
 * the port adapters work against a real workspace. It stays deliberately thin —
 * the dependency rule pushed the logic into `core`, where it is tested in
 * milliseconds instead of minutes.
 */

// Paths resolve from the built location (`out/test/`), not the source tree: this
// file runs as CommonJS in a plain Node process that VS Code did not start.
async function main(): Promise<void> {
  // The extension root, i.e. the directory holding the manifest VS Code loads.
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');
  // A real folder, because TARS refuses to open a session without one (C3) and
  // the file index has nothing to walk otherwise.
  const workspacePath = path.resolve(extensionDevelopmentPath, 'test', 'fixtures', 'workspace');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      // Other extensions would contribute language servers, watchers and
      // commands that make failures depend on what the machine happens to have
      // installed.
      '--disable-extensions',
      '--disable-gpu',
    ],
  });
}

main().catch((error: unknown) => {
  console.error('integration tests failed to run:', error);
  process.exitCode = 1;
});
