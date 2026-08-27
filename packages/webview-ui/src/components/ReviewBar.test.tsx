import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChangeSummary } from '@tars/shared';
import { resetTarsStore, useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { ReviewBar } from './ReviewBar.js';

vi.mock('../vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

function change(overrides: Partial<PendingChangeSummary> = {}): PendingChangeSummary {
  return { path: 'src/a.ts', kind: 'modify', added: 3, removed: 1, stale: false, ...overrides };
}

function setChanges(changes: readonly PendingChangeSummary[]): void {
  act(() => {
    useTarsStore.getState().receive({
      type: 'change_set',
      changes,
      added: changes.reduce((total, entry) => total + entry.added, 0),
      removed: changes.reduce((total, entry) => total + entry.removed, 0),
    });
  });
}

beforeEach(() => {
  resetTarsStore();
  vi.mocked(postToHost).mockClear();
});

describe('ReviewBar', () => {
  it('stays out of the way when there is nothing to review', () => {
    const { container } = render(<ReviewBar />);
    expect(container.innerHTML).toBe('');
  });

  it('summarises what changed', () => {
    render(<ReviewBar />);
    setChanges([change(), change({ path: 'src/b.ts', added: 0, removed: 4 })]);

    expect(screen.getByRole('heading').textContent).toBe('2 files changed');
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('−5')).toBeTruthy();
  });

  it('uses the singular for one file', () => {
    render(<ReviewBar />);
    setChanges([change()]);

    expect(screen.getByRole('heading').textContent).toBe('1 file changed');
  });

  it('opens the file itself when the path is clicked', async () => {
    render(<ReviewBar />);
    setChanges([change(), change({ path: 'src/b.ts' })]);

    await userEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));

    // The per-hunk controls are on the code, so the list is a way into the
    // editor rather than a review surface of its own.
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'open_file',
      path: 'src/b.ts',
    });
  });

  it('offers the side-by-side diff on its own control', async () => {
    render(<ReviewBar />);
    setChanges([change({ path: 'src/b.ts' })]);

    await userEvent.click(
      screen.getByRole('button', { name: 'Open a side-by-side diff of src/b.ts' }),
    );

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'review_action',
      action: 'review',
      path: 'src/b.ts',
    });
  });

  it('offers Keep and Revert rather than Apply and Discard', () => {
    render(<ReviewBar />);
    setChanges([change()]);

    // The wording is load-bearing: the files are already on disk, and "Apply"
    // would tell the user the change is still pending when it is not.
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revert' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.getByText(/accept and reject each change in the editor/)).toBeTruthy();
  });

  it('sends keep', async () => {
    render(<ReviewBar />);
    setChanges([change()]);

    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'review_action', action: 'keep' });
  });

  it('sends revert', async () => {
    render(<ReviewBar />);
    setChanges([change()]);

    await userEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'review_action', action: 'revert' });
  });

  it('calls out files that moved after TARS read them', () => {
    render(<ReviewBar />);
    setChanges([change({ stale: true }), change({ path: 'src/b.ts' })]);

    // A stale entry means what is on disk may be a silent overwrite of someone
    // else's edit, which the file list alone does not convey.
    expect(screen.getByRole('status').textContent).toContain('1 file changed after TARS read it');
  });

  it('says nothing about staleness when nothing is stale', () => {
    render(<ReviewBar />);
    setChanges([change()]);

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retires once the host reports an empty change set', () => {
    const { container } = render(<ReviewBar />);
    setChanges([change()]);
    expect(container.innerHTML).not.toBe('');

    setChanges([]);
    expect(container.innerHTML).toBe('');
  });

  it('names each file kind for assistive tech, not only by glyph', () => {
    render(<ReviewBar />);
    setChanges([
      change({ path: 'a.ts', kind: 'create' }),
      change({ path: 'b.ts', kind: 'delete' }),
    ]);

    expect(screen.getByText('created')).toBeTruthy();
    expect(screen.getByText('deleted')).toBeTruthy();
  });
});
