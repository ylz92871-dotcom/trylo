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

vi.mock('../../monaco-init', () => ({ initMonaco: async () => undefined }));
import { GitDiffView, type GitFileDiffData } from './GitDiffView';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
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
    expect(status.textContent).toContain('无法加载此文件的变更');
    expect(status.textContent).toContain('boom');
  });

  it('shows a role=status message for binary files', () => {
    const diff: GitFileDiffData = { original: '', modified: '', binary: true, truncated: false };
    render(<GitDiffView path="src/foo.ts" diff={diff} onClose={() => {}} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('二进制文件无法显示文本差异');
  });

  it('shows a role=status message for truncated files', () => {
    const diff: GitFileDiffData = { original: '', modified: '', binary: false, truncated: true };
    render(<GitDiffView path="src/foo.ts" diff={diff} onClose={() => {}} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('文件过大，未提供完整差异');
  });

  it('announces loading while content is unavailable instead of showing an empty editor', () => {
    const { container } = render(<GitDiffView path="src/foo.ts" onClose={() => {}} />);
    expect(container.querySelector('.git-diff-view__monaco')).toBeNull();
    expect(screen.getByRole('status', { name: '加载变更' }).textContent).toContain('正在加载变更');
  });
});

describe('GitDiffView — close + focus return', () => {
  it('shows an approval notice without hiding the proposed diff', () => {
    const { container } = render(<GitDiffView path="src/a.ts" notice="等待批准，查看不会自动批准"
      diff={{ original: 'before', modified: 'after', binary: false, truncated: false }} onClose={vi.fn()} />);
    expect(screen.getByRole('status', { name: '变更说明' }).textContent).toContain('等待批准');
    expect(container.querySelector('.git-diff-view__monaco')).not.toBeNull();
  });
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

it('keeps close and focus return available before diff data finishes loading', () => {
  const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
  const close = vi.fn();
  render(<GitDiffView path="src/loading.ts" onClose={close} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(opener); opener.remove();
});
