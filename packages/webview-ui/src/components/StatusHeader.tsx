import type { JSX } from 'react';
import { useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';

export function StatusHeader(): JSX.Element {
  const connected = useTarsStore((state) => state.connected);
  const busy = useTarsStore((state) => state.busy);
  const workspaceName = useTarsStore((state) => state.workspaceName);
  const usage = useTarsStore((state) => state.usage);

  return (
    <header className="flex items-center gap-2 border-b border-panel-border px-3 py-2">
      <span className="font-mono">TARS</span>

      <span className="min-w-0 flex-1 truncate text-description-fg" title={workspaceName ?? undefined}>
        {workspaceName ?? 'no workspace'}
      </span>

      {usage !== null && (
        <span className="text-description-fg" title="input / output tokens this turn">
          {usage.inputTokens}↑ {usage.outputTokens}↓
        </span>
      )}

      {/*
        `aria-live` on the status line rather than a toast: connection and busy are
        ambient facts, so they are announced when they change and otherwise silent.
      */}
      <span aria-live="polite" className="flex items-center gap-1 text-description-fg">
        <span
          aria-hidden="true"
          className={connected ? (busy ? 'text-warning-fg' : 'text-success-fg') : 'text-error-fg'}
        >
          ●
        </span>
        {connected ? (busy ? 'working' : 'ready') : 'connecting'}
      </span>

      <button
        type="button"
        onClick={() => {
          postToHost({ type: 'new_session' });
        }}
        className="rounded bg-secondary-bg px-2 py-1 text-secondary-fg hover:bg-secondary-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
      >
        New session
      </button>
    </header>
  );
}
