// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The dependency rule from Docs/TARS_SPEC.md §3.1:
 *
 *   extension -> host -> core -> shared
 *   webview-ui -> shared
 *
 * These patterns are the mechanical enforcement of that rule. A boundary that is
 * only documented erodes; this one fails the build.
 */
const SPEC = 'Docs/TARS_SPEC.md §3.1';

const forbidVscode = {
  group: ['vscode'],
  message: `Only packages/host may import 'vscode'. Keeping it out of core/shared is what makes agent orchestration, the diff engine and checkpoints unit-testable in plain Node, and preserves the option to lift core into a sidecar. See ${SPEC}. Depend on a port from core/src/ports instead.`,
};

const forbidSdk = {
  group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
  message: `The Agent SDK is pre-1.0; only packages/core/src/provider/claude-code/** may import it so that an SDK breaking change has a one-file blast radius. Consume the normalized AgentEvent union from @tars/shared instead. See ${SPEC} and §4.1.`,
};

const forbidReact = {
  group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'zustand'],
  message: `UI libraries belong to packages/webview-ui only. core and shared must stay renderer-agnostic so business logic is testable without a DOM. See ${SPEC}.`,
};

const forbidHostAndUi = {
  group: [
    '@tars/host',
    '@tars/host/*',
    '@tars/webview-ui',
    '@tars/webview-ui/*',
    '@tars/extension',
    '@tars/extension/*',
    '**/host',
    '**/host/*',
    '**/webview-ui',
    '**/webview-ui/*',
  ],
  message: `Dependencies flow one way only (extension -> host -> core -> shared). core/shared importing host, webview-ui or extension inverts the arrow and reintroduces the monolith. See ${SPEC}.`,
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'Docs/**',
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  {
    files: ['packages/core/**/*.ts', 'packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [forbidVscode, forbidSdk, forbidReact, forbidHostAndUi] },
      ],
    },
  },

  {
    // The single sanctioned exception: the Claude Code adapter is the one module
    // allowed to see SDK types (Docs/TARS_SPEC.md §4.1).
    files: ['packages/core/src/provider/claude-code/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [forbidVscode, forbidReact, forbidHostAndUi] },
      ],
    },
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // Test doubles legitimately assert shapes the compiler cannot infer from a literal.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
