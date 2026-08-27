import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingPermission } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { PermissionPrompt } from './PermissionPrompt.js';

vi.mock('../vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

/**
 * The permission prompt is the product's safety surface: the agent is blocked on
 * the promise behind these buttons. The assertions below are about what each
 * control *sends*, not how it looks — a button relabelled is cosmetic, a button
 * wired to the wrong wire value silently widens what the agent may do.
 */

function request(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: 'req_1',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    affectedPaths: [],
    defaultPolicy: 'ask',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(postToHost).mockClear();
});

describe('PermissionPrompt', () => {
  it('renders nothing when no approval is outstanding', () => {
    const { container } = render(<PermissionPrompt requests={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('gives focus to Deny, so a stray Enter cannot approve a shell command', () => {
    render(<PermissionPrompt requests={[request()]} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }));
  });

  it('sends deny', async () => {
    render(<PermissionPrompt requests={[request()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'permission_decision',
      requestId: 'req_1',
      decision: 'deny',
    });
  });

  it('sends a one-shot allow for "Allow once", which must not promote the tool', async () => {
    render(<PermissionPrompt requests={[request()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    // `ask` is the broker's vocabulary for "approved, do not promote". Sending
    // `always_allow` here would silently stop prompting for every later Bash call.
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'permission_decision',
      requestId: 'req_1',
      decision: 'ask',
    });
  });

  it('sends a session promotion only for the button that says so', async () => {
    render(<PermissionPrompt requests={[request()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }));

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'permission_decision',
      requestId: 'req_1',
      decision: 'always_allow',
    });
  });

  it('shows the tool arguments verbatim, since the decision can turn on any field', () => {
    render(<PermissionPrompt requests={[request({ input: { command: 'curl example.com' } })]} />);
    expect(screen.getByText(/curl example\.com/)).toBeTruthy();
  });

  it('lists the affected paths as openable controls', () => {
    render(<PermissionPrompt requests={[request({ affectedPaths: ['src/a.ts', 'src/b.ts'] })]} />);

    expect(screen.getByRole('button', { name: 'src/a.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'src/b.ts' })).toBeTruthy();
  });

  it('renders every outstanding request, so a queued approval cannot be hidden', () => {
    render(
      <PermissionPrompt
        requests={[request(), request({ requestId: 'req_2', toolName: 'Write' })]}
      />,
    );

    expect(screen.getAllByRole('alertdialog')).toHaveLength(2);
  });

  it('routes each decision to its own request id', async () => {
    render(
      <PermissionPrompt
        requests={[request(), request({ requestId: 'req_2', toolName: 'Write' })]}
      />,
    );

    const denies = screen.getAllByRole('button', { name: 'Deny' });
    const second = denies[1];
    expect(second).toBeDefined();
    await userEvent.click(second as HTMLElement);

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'permission_decision',
      requestId: 'req_2',
      decision: 'deny',
    });
  });
});
