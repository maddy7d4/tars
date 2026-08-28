import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the size budgets of Docs/PERFORMANCE.md.
 *
 * Only artefacts TARS controls are budgeted. The extension bundle is dominated
 * by the Agent SDK, which TARS does not choose the size of; budgeting it would
 * turn an upstream release into a red build that says nothing about this code.
 *
 * The numbers are ceilings with real headroom, not high-water marks. A budget
 * set at the current size fails on the next honest change and trains everyone
 * to raise it without thinking, which is worse than no budget at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** @type {readonly {path: string, limitKb: number, why: string}[]} */
const BUDGETS = [
  {
    path: 'packages/webview-ui/dist/assets/main.js',
    limitKb: 400,
    why: 'The panel is React plus a transcript reducer. Anything approaching this ceiling means a dependency arrived that should have stayed in the host.',
  },
  {
    path: 'packages/webview-ui/dist/assets/main.css',
    limitKb: 64,
    why: 'Tailwind emits only what the components use. Growth here means unused utilities are being retained.',
  },
];

let failed = false;

for (const budget of BUDGETS) {
  const absolute = resolve(root, budget.path);
  let size;
  try {
    ({ size } = await stat(absolute));
  } catch {
    process.stderr.write(`budget: ${budget.path} is missing — run \`pnpm build\` first\n`);
    failed = true;
    continue;
  }

  const kb = size / 1024;
  const status = kb <= budget.limitKb ? 'ok  ' : 'OVER';
  process.stdout.write(
    `${status} ${budget.path}: ${kb.toFixed(1)} KB / ${String(budget.limitKb)} KB\n`,
  );
  if (kb > budget.limitKb) {
    process.stderr.write(`      ${budget.why}\n`);
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
