import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
const webviewSource = resolve(here, '..', 'webview-ui', 'dist');
const webviewTarget = resolve(outDir, 'webview');
const mediaSource = resolve(here, 'media');
const mediaTarget = resolve(outDir, 'media');

const watch = process.argv.includes('--watch');
const production =
  process.env['NODE_ENV'] === 'production' || process.argv.includes('--production');

function log(message) {
  process.stdout.write(`[esbuild] ${message}\n`);
}

/**
 * Copies the Vite build into the bundle. The webview is loaded from the
 * extension's own directory over `asWebviewUri`, and `.vscodeignore` ships only
 * `dist/`, so the assets have to live inside it.
 */
async function copyAssets() {
  await mkdir(outDir, { recursive: true });

  await rm(webviewTarget, { recursive: true, force: true });
  await cp(webviewSource, webviewTarget, { recursive: true });

  // The activity-bar icon lives under dist/ too, so `.vscodeignore` can ship
  // exactly one directory rather than an allowlist that drifts.
  await rm(mediaTarget, { recursive: true, force: true });
  await cp(mediaSource, mediaTarget, { recursive: true });

  log(`copied webview and media assets -> ${outDir}`);
}

/** Reports rebuilds in watch mode; without it a failed rebuild is silent. */
const reportPlugin = {
  name: 'tars-report',
  setup(build) {
    build.onEnd(async (result) => {
      for (const message of result.errors) {
        process.stderr.write(`[esbuild] error: ${message.text}\n`);
      }
      if (result.errors.length === 0) {
        await copyAssets();
        log('bundle written');
      }
    });
  },
};

/**
 * `import.meta.url`, for dependencies authored as ESM.
 *
 * VS Code loads the extension with `require`, so the bundle must be CommonJS —
 * and esbuild replaces `import.meta` with an empty object there, making
 * `import.meta.url` `undefined`. The Agent SDK calls
 * `createRequire(import.meta.url)` at module scope, so without this the
 * extension throws before `activate` is ever reached.
 *
 * Caught by the integration suite, which loads the real bundle in a real editor;
 * no unit test can see it, because nothing under test is what breaks.
 */
const importMetaUrlShim = "const __tars_import_meta_url = require('node:url').pathToFileURL(__filename).href;";

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src', 'extension.ts')],
  outfile: resolve(outDir, 'extension.js'),
  bundle: true,
  platform: 'node',
  // VS Code loads the extension entry point with `require`, not `import`.
  format: 'cjs',
  target: 'node20',
  // Provided by the editor at runtime and absent from node_modules.
  external: ['vscode'],
  banner: { js: importMetaUrlShim },
  define: { 'import.meta.url': '__tars_import_meta_url' },
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'silent',
  plugins: [reportPlugin],
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  log('watching for changes');
} else {
  await esbuild.build(options);
}
