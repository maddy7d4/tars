import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostToWebview } from '@tars/shared';
import { App } from './App.js';
import { resetTarsStore, useTarsStore } from './store.js';
import { postToHost } from './vscode-api.js';

vi.mock('./vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

/**
 * Delivers a host message the way the webview actually receives one. Wrapped in
 * `act` because the listener writes to the store from outside React's event
 * system, so nothing repaints until the update is flushed.
 */
function fromHost(message: HostToWebview): void {
  act(() => {
    window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: message }));
  });
}

beforeEach(() => {
  resetTarsStore();
  vi.mocked(postToHost).mockClear();
});

describe('App', () => {
  it('announces readiness on mount rather than assuming it missed nothing', () => {
    render(<App />);

    // The host may finish activating before the renderer mounts, so the handshake
    // is webview-initiated; without this a fast activation would strand the view.
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'webview_ready',
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('routes host messages into the store while mounted', () => {
    render(<App />);
    fromHost({ type: 'config', permissionPolicy: 'ask', workspaceName: 'tars' });

    expect(useTarsStore.getState().workspaceName).toBe('tars');
    expect(screen.getByText('tars')).toBeTruthy();
  });

  it('stops listening once unmounted, so a disposed view cannot mutate the store', () => {
    const { unmount } = render(<App />);
    unmount();

    fromHost({ type: 'config', permissionPolicy: 'ask', workspaceName: 'tars' });
    expect(useTarsStore.getState().workspaceName).toBeNull();
  });

  it('shows the composer and no approval prompt in the ordinary case', () => {
    render(<App />);
    fromHost({ type: 'ready', protocolVersion: PROTOCOL_VERSION });

    expect(screen.getByLabelText('Message TARS')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('puts an outstanding approval between the transcript and the input', () => {
    render(<App />);
    fromHost({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    act(() => {
      useTarsStore.setState({
        pendingPermissions: [
          {
            requestId: 'req_1',
            toolName: 'Bash',
            input: { command: 'ls' },
            affectedPaths: [],
            defaultPolicy: 'ask',
          },
        ],
      });
    });

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // The composer stays: the user may still be mid-sentence, and hiding it would
    // discard what they typed. Only a protocol mismatch takes the input away.
    expect(screen.getByLabelText('Message TARS')).toBeTruthy();
  });

  it('replaces the composer with the failure when the protocol does not match', () => {
    render(<App />);
    // A version this bundle cannot read is unrepresentable in `HostToWebview`; it
    // only arises across two builds, which the cast reproduces.
    fromHost({ type: 'ready', protocolVersion: 99 } as unknown as HostToWebview);

    expect(screen.getByRole('alert').textContent).toContain('protocol mismatch');
    // Offering a prompt box that can only produce mis-parsed traffic is worse than
    // offering none, so the input is gone rather than merely disabled.
    expect(screen.queryByLabelText('Message TARS')).toBeNull();
  });
});
