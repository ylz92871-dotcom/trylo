import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchPanel, type SearchPanelAction } from './SearchPanel';
import { SourceReaderTools } from '../preview/SourceReaderTools';
import { hostAdapter } from '../../host-adapter';

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

let restorePlatform: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restorePlatform?.();
  restorePlatform = undefined;
  vi.restoreAllMocks();
});

describe('Platform shortcuts in SearchPanel and SourceReaderTools', () => {
  it('uses Cmd+Shift+F and shows ⇧⌘F / ⌘F on macOS', () => {
    restorePlatform = mockPlatform('MacIntel');
    render(
      <>
        <SearchPanel searchRoot="/tmp/ws" onResultOpen={vi.fn()} />
        <SourceReaderTools wrap={false} onWrap={vi.fn()} onFind={vi.fn()} onCopy={vi.fn()} />
      </>,
    );
    const input = screen.getByPlaceholderText('Search (⇧⌘F)');
    fireEvent.keyDown(document, { key: 'F', metaKey: true, shiftKey: true });
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: '查找' })).toHaveAttribute('title', '查找 · ⌘F');
  });

  it('uses Ctrl+Shift+F and shows Ctrl+Shift+F / Ctrl+F on Windows', () => {
    restorePlatform = mockPlatform('Win32');
    render(
      <>
        <SearchPanel searchRoot="/tmp/ws" onResultOpen={vi.fn()} />
        <SourceReaderTools wrap={false} onWrap={vi.fn()} onFind={vi.fn()} onCopy={vi.fn()} />
      </>,
    );
    const input = screen.getByPlaceholderText('Search (Ctrl+Shift+F)');
    fireEvent.keyDown(document, { key: 'F', ctrlKey: true, shiftKey: true });
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: '查找' })).toHaveAttribute('title', '查找 · Ctrl+F');
  });
});

describe('SearchPanel Spotlight command palette modal', () => {
  it('filters actions, supports ArrowDown/Enter/Escape navigation, and formats HIG shortcuts on macOS', () => {
    restorePlatform = mockPlatform('MacIntel');
    const onNewTask = vi.fn();
    const onSettings = vi.fn();
    const onClose = vi.fn();
    const actions: readonly SearchPanelAction[] = [
      { id: 'new-task', label: '新建任务', hint: '创建新对话', shortcut: ['Mod', 'N'], keywords: 'new chat', onSelect: onNewTask },
      { id: 'settings', label: '打开设置', hint: '模型与外观', shortcut: ['Mod', ','], keywords: 'preferences', onSelect: onSettings },
    ];

    const view = render(
      <SearchPanel
        modal
        open
        onClose={onClose}
        searchRoot="/tmp/ws"
        onResultOpen={vi.fn()}
        actions={actions}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '命令面板与工作区搜索' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('⌘N')).toBeInTheDocument();
    expect(screen.getByText('⌘,')).toBeInTheDocument();

    const input = screen.getByRole('combobox', { name: '命令或工作区搜索' });
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: 'new' } });
    expect(screen.getByText('新建任务')).toBeInTheDocument();
    expect(screen.queryByText('打开设置')).toBeNull();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    view.rerender(
      <SearchPanel
        modal
        open={false}
        onClose={onClose}
        searchRoot="/tmp/ws"
        onResultOpen={vi.fn()}
        actions={actions}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs workspace search in modal mode and opens selected file match', async () => {
    const onResultOpen = vi.fn();
    const searchSpy = vi
      .spyOn(hostAdapter.search, 'search')
      .mockResolvedValue([{ path: 'src/App.tsx', line: 42, content: 'const hello = true;' }]);

    render(
      <SearchPanel
        modal
        open
        onClose={vi.fn()}
        searchRoot="/tmp/ws"
        onResultOpen={onResultOpen}
        actions={[]}
      />,
    );

    const input = screen.getByRole('combobox', { name: '工作区全文搜索' });
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索工作区' }));

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith('hello', '/tmp/ws', {
        regex: false,
        caseInsensitive: false,
      });
    });

    const matchNode = await screen.findByText('src/App.tsx:42');
    fireEvent.click(matchNode);
    expect(onResultOpen).toHaveBeenCalledWith('src/App.tsx', 42);
  });
});
