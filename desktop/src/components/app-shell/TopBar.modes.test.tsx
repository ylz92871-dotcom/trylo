import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

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
});

describe('Conversation header', () => {
  it('shows the selected workspace and conversation, and reopens the sidebar', () => {
    const toggle = vi.fn();
    render(<TopBar workspaceName="Project A" conversationTitle="Fix import" collapsed onToggleLeftRail={toggle} />);
    expect(screen.getByText('Project A')).toBeVisible();
    expect(screen.getByText('Fix import')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand rail' }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('retains actual host actions and the collaboration surface', () => {
    const files = vi.fn();
    render(
      <TopBar
        workspaceName="Project B"
        collapsed={false}
        onToggleLeftRail={vi.fn()}
        collaborationSwitch={<span>Team</span>}
        right={<button onClick={files}>Files</button>}
      />,
    );
    expect(screen.getByText('Team')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Files' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(files).toHaveBeenCalledOnce();
  });

  it.each(['code', 'work'] as const)(
    'renders the Code | Work segmented switcher in %s mode and switches on click',
    (mode) => {
      const onTopModeChange = vi.fn();
      render(
        <TopBar
          workspaceName="Project C"
          collapsed={false}
          onToggleLeftRail={vi.fn()}
          topMode={mode}
          onTopModeChange={onTopModeChange}
        />,
      );

      const group = screen.getByRole('group', { name: '工作模式' });
      expect(group).toBeVisible();
      const thumb = group.querySelector('.top-bar__mode-thumb');
      expect(thumb).toHaveAttribute('data-active-index', mode === 'work' ? '1' : '0');
      const codeBtn = screen.getByRole('button', { name: 'Code' });
      const workBtn = screen.getByRole('button', { name: 'Work' });
      expect(codeBtn).toHaveAttribute('aria-pressed', mode === 'code' ? 'true' : 'false');
      expect(workBtn).toHaveAttribute('aria-pressed', mode === 'work' ? 'true' : 'false');

      const nextMode = mode === 'code' ? 'work' : 'code';
      fireEvent.click(nextMode === 'work' ? workBtn : codeBtn);
      expect(onTopModeChange).toHaveBeenCalledWith(nextMode);
    },
  );

  it('marks macOS toolbar drag regions while keeping controls non-draggable and omits them on Windows', () => {
    restorePlatform = mockPlatform('MacIntel');
    const { container } = render(
      <TopBar
        workspaceName="Project Mac"
        conversationTitle="Polish shell"
        collapsed
        onToggleLeftRail={vi.fn()}
        topMode="code"
        onTopModeChange={vi.fn()}
      />,
    );

    const header = container.querySelector('.top-bar');
    expect(header).toHaveAttribute('data-tauri-drag-region', '');
    expect(header).toHaveAttribute('data-rail-collapsed', 'true');
    expect(screen.getByText('Project Mac')).toHaveAttribute('data-tauri-drag-region', '');
    expect(screen.getByText('Polish shell')).toHaveAttribute('data-tauri-drag-region', '');
    expect(screen.getByRole('button', { name: 'Expand rail' })).toHaveAttribute('data-tauri-drag-region', 'false');
    expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute('data-tauri-drag-region', 'false');
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('data-tauri-drag-region', 'false');

    cleanup();
    restorePlatform();
    restorePlatform = mockPlatform('Win32');
    const win = render(
      <TopBar
        workspaceName="Project Win"
        collapsed={false}
        onToggleLeftRail={vi.fn()}
        topMode="work"
        onTopModeChange={vi.fn()}
      />,
    );

    const winHeader = win.container.querySelector('.top-bar');
    expect(winHeader).not.toHaveAttribute('data-tauri-drag-region');
    expect(winHeader).toHaveAttribute('data-rail-collapsed', 'false');
    expect(screen.getByRole('button', { name: 'Code' })).not.toHaveAttribute('data-tauri-drag-region');
  });
});
