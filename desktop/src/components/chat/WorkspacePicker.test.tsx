import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePicker } from './WorkspacePicker';
import { WorkspaceNavigationContext } from '../app-shell/WorkspaceNavigationContext';

afterEach(cleanup);
const workspaces = [{ id: 'one', name: 'trylo', root: 'D:/CC/trylo' },
  { id: 'two', name: 'workspace', root: 'D:/projects/workspace' },
  { id: 'three', name: 'workspace', root: 'E:/other/workspace' }];
function setup() {
  const switchWorkspace = vi.fn(), openFolder = vi.fn();
  render(<WorkspaceNavigationContext.Provider value={{ workspaces, currentWorkspaceId: 'one', onSwitchWorkspace: switchWorkspace, onOpenFolder: openFolder }}>
    <WorkspacePicker workspace="D:/CC/trylo" />
  </WorkspaceNavigationContext.Provider>);
  return { switchWorkspace, openFolder, trigger: screen.getByRole('button', { name: '切换工作区：trylo' }) };
}

describe('composer workspace navigation', () => {
  it('selects the exact project by keyboard and keeps duplicate names distinguishable by path', () => {
    const { trigger, switchWorkspace } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const current = screen.getByRole('menuitemradio', { name: /trylo/ });
    expect(current).toHaveFocus();
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /E:\/other\/workspace/ })).toBeVisible();
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    const next = screen.getByRole('menuitemradio', { name: /D:\/projects\/workspace/ });
    expect(next).toHaveFocus();
    fireEvent.click(next);
    expect(switchWorkspace).toHaveBeenCalledOnce();
    expect(switchWorkspace).toHaveBeenCalledWith('two');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
  it('does not navigate when selecting the current project or cancelling with Escape', () => {
    const { trigger, switchWorkspace } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /trylo/ }));
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
  it('routes opening another project through the existing host-owned action and dismisses on outside pointer', () => {
    const { trigger, openFolder, switchWorkspace } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: '打开其他项目…' }));
    expect(openFolder).toHaveBeenCalledOnce();
    expect(switchWorkspace).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('uses an honest static label when rendered outside a navigation-capable shell', () => {
    render(<WorkspacePicker workspace="D:/CC/trylo" />);
    expect(screen.getByText('trylo')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
