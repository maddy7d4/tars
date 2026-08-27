import { useEffect, type JSX } from 'react';
import { PROTOCOL_VERSION, type HostToWebview } from '@tars/shared';
import { useTarsStore } from './store.js';
import { postToHost } from './vscode-api.js';
import { MessageList } from './components/MessageList.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { PromptInput } from './components/PromptInput.js';
import { StatusHeader } from './components/StatusHeader.js';

export function App(): JSX.Element {
  const pendingPermissions = useTarsStore((state) => state.pendingPermissions);
  const protocolMismatch = useTarsStore((state) => state.protocolMismatch);
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
      <StatusHeader />
      <MessageList />

      {protocolMismatch ? (
        // Fatal and not recoverable from inside the webview, so it takes the input's
        // place: offering a prompt box that can only produce mis-parsed traffic is worse
        // than offering nothing.
        <p role="alert" className="border-t border-panel-border px-3 py-2 text-error-fg">
          {lastError}
        </p>
      ) : (
        <>
          {/* Pending approvals sit between the transcript and the input, where the
              user's attention already is when a turn stalls waiting on them. */}
          <PermissionPrompt requests={pendingPermissions} />
          <PromptInput />
        </>
      )}
    </div>
  );
}
