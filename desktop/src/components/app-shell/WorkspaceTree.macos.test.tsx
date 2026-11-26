import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTree } from './WorkspaceTree';
import type { FilePath } from '../../host-adapter/types';

const invokeMock = vi.hoisted(() => vi.fn());
const listDirMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../../host-adapter', () => ({
  hostAdapter: {
    fs: {
      listDir: listDirMock,
    },
  },
}));

function setTauriGlobal(enabled: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (enabled) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

let restorePlatform: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  setTauriGlobal(true);
  restorePlatform = mockPlatform('MacIntel');
  listDirMock.mockResolvedValue([
    { name: 'src', path: '/repo/src', isDirectory: true },
    { name: 'README.md', path: '/repo/README.md', isDirectory: false },
  ]);
});

afterEach(() => {
  cleanup();
  setTauriGlobal(false);
  restorePlatform?.();
  restorePlatform = undefined;
});

describe('WorkspaceTree macOS native context menu', () => {
  it('opens native NSMenu on file right-click and copies relative path / reveals in Finder', async () => {
    const onSelect = vi.fn();
    render(<WorkspaceTree root={'/repo' as FilePath} onSelect={onSelect} />);

    const fileRow = await screen.findByRole('treeitem', { name: 'README.md' });
    invokeMock.mockResolvedValueOnce('reveal').mockResolvedValueOnce(undefined);
    fireEvent.contextMenu(fileRow);

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_native_context_menu', {
        items: [
          { id: 'preview', label: '预览文件' },
          { id: 'reveal', label: '在 Finder 中显示' },
          { id: 'open-default', label: '用默认应用打开' },
          { id: 'sep-1', label: '', separator: true },
          { id: 'copy-rel', label: '复制相对路径' },
          { id: 'copy-abs', label: '复制绝对路径' },
        ],
      });
      expect(invokeMock).toHaveBeenCalledWith('work_host_show_in_folder', {
        filePath: '/repo/README.md',
        allowedRoot: '/repo',
      });
    });

    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce('copy-rel').mockResolvedValueOnce(undefined);
    fireEvent.contextMenu(fileRow);

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('work_host_copy_to_clipboard', {
        text: 'README.md',
      });
    });
  });

  it('opens native NSMenu on folder right-click and can expand/collapse or copy path', async () => {
    render(<WorkspaceTree root={'/repo' as FilePath} />);

    const dirRow = await screen.findByRole('treeitem', { name: 'src' });
    expect(dirRow).toHaveAttribute('aria-expanded', 'false');

    invokeMock.mockResolvedValueOnce('toggle');
    fireEvent.contextMenu(dirRow);

    await vi.waitFor(() => {
      expect(dirRow).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
