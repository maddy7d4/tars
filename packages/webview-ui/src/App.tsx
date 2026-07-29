import { useEffect, type JSX } from 'react';
import { PROTOCOL_VERSION, type HostToWebview } from '@tars/shared';
import { useTarsStore } from './store.js';
import { postToHost } from './vscode-api.js';

export function App(): JSX.Element {
  const connected = useTarsStore((state) => state.connected);
  const busy = useTarsStore((state) => state.busy);
  const workspaceName = useTarsStore((state) => state.workspaceName);
  const assistantText = useTarsStore((state) => state.assistantText);
  const lastError = useTarsStore((state) => state.lastError);
  const receive = useTarsStore((state) => state.receive);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>): void => {
      receive(event.data);
    };
    window.addEventListener('message', onMessage);
    // The host may finish activating before the renderer mounts, so the webview
    // announces readiness rather than assuming it can miss nothing.
    postToHost({ type: 'webview_ready', protocolVersion: PROTOCOL_VERSION });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [receive]);

  return (
    <div className="flex h-full flex-col bg-editor-bg text-editor-fg">
      <header className="flex items-center justify-between border-b border-panel-border px-3 py-2">
        <span className="font-mono text-editor-fg">TARS</span>
        <span className="text-description-fg">
          {workspaceName ?? 'no workspace'} · {connected ? 'connected' : 'connecting'}
          {busy ? ' · working' : ''}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-2">
        {lastError !== null && (
          <p role="alert" className="mb-2 font-mono text-editor-fg">
            {lastError}
          </p>
        )}
        {assistantText === '' ? (
          <p className="text-description-fg">
            Ask TARS about this workspace. The chat surface arrives in phase 2.
          </p>
        ) : (
          <p className="whitespace-pre-wrap">{assistantText}</p>
        )}
      </main>

      <footer className="border-t border-panel-border px-3 py-2">
        <button
          type="button"
          onClick={() => {
            postToHost({ type: 'new_session' });
          }}
          className="rounded bg-button-bg px-3 py-1 text-button-fg focus:outline-2 focus:outline-focus-border"
        >
          New session
        </button>
      </footer>
    </div>
  );
}
