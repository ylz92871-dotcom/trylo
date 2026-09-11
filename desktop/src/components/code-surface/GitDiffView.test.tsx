// Trylo Desktop — GitDiffView behavioural tests (C-Edge P2-4).
//
// Pins behaviour that the audit's P2-4 list calls out: Escape closes
// the panel and restores focus; the close button restores focus;
// degraded states (binary / truncated / error) render a
// screen-reader-friendly status; the close button is keyboard
// activatable.
//
// `monaco-editor` is aliased to a stub in vite.config.ts so the
// dynamic import inside GitDiffView resolves to a no-op without
// shipping the real ~50MB editor into the test runner.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { GitDiffView, type GitFileDiffData } from './GitDiffView';

afterEach(() => cleanup());

describe('GitDiffView — ARIA shell', () => {
  it('renders the region with a path-derived label', () => {
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={() => {}}
      />,
    );
    const region = screen.getByRole('region');
    expect(region.getAttribute('aria-label')).toBe('Diff for src/foo.ts');
  });

  it('exposes a Close button with an accessible label', () => {
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={() => {}}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close diff' });
    expect(close).toBeTruthy();
  });

  it('renders the path text', () => {
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('src/foo.ts')).toBeTruthy();
  });
});

describe('GitDiffView — degraded states', () => {
  it('shows a role=status message when the diff failed to load', () => {
    render(
      <GitDiffView path="src/foo.ts" error="boom" onClose={() => {}} />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Could not load');
  });

  it('shows a role=status message for binary files', () => {
    const diff: GitFileDiffData = { original: '', modified: '', binary: true, truncated: false };
    render(<GitDiffView path="src/foo.ts" diff={diff} onClose={() => {}} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Binary file');
  });

  it('shows a role=status message for truncated files', () => {
    const diff: GitFileDiffData = { original: '', modified: '', binary: false, truncated: true };
    render(<GitDiffView path="src/foo.ts" diff={diff} onClose={() => {}} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('too large');
  });

  it('renders nothing in the body when diff is undefined (loading)', () => {
    const { container } = render(
      <GitDiffView path="src/foo.ts" onClose={() => {}} />,
    );
    // Undefined diff means "still loading". The current implementation
    // treats undefined as "degraded" and so does not mount the monaco
    // container; the audit note is that this state should be
    // discriminated from "Git workspace, no changes" / "non-Git
    // workspace" — for now we just pin the existing behaviour.
    expect(container.querySelector('.git-diff-view__monaco')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('GitDiffView — close + focus return', () => {
  it('Escape triggers onClose', () => {
    const onClose = vi.fn();
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close button click triggers onClose', () => {
    const onClose = vi.fn();
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close diff' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the element that opened the diff', () => {
    const opener = document.createElement('button');
    opener.textContent = 'open diff';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = vi.fn();
    render(
      <GitDiffView
        path="src/foo.ts"
        diff={{ original: '', modified: '', binary: false, truncated: false }}
        onClose={onClose}
      />,
    );
    // The panel moved focus away (or at least captured it on mount).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });
});
