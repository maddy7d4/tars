import * as path from 'node:path';
import Mocha from 'mocha';

/**
 * The entry point VS Code calls inside the test instance.
 *
 * Mocha is constructed by hand rather than driven from a config file because
 * this runs inside the extension host, where there is no CLI to read one.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    // Downloading and starting an editor makes the first assertion slow in a way
    // that says nothing about the code under test.
    timeout: 30_000,
  });

  mocha.addFile(path.resolve(__dirname, 'extension.test.cjs'));

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${String(failures)} integration test(s) failed`));
          return;
        }
        resolve();
      });
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
