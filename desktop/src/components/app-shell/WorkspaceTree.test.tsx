import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, FilePath } from '../../host-adapter/types';
import { WorkspaceTree } from './WorkspaceTree';

const fs = vi.hoisted(() => ({ listDir: vi.fn() }));
vi.mock('../../host-adapter', () => ({ hostAdapter: { fs } }));
const root = 'D:/CC/trylo' as FilePath;
const entry = (name: string, isDirectory = false, parent: FilePath = root): DirEntry => ({ name, path: `${parent}/${name}` as FilePath, isDirectory });
const rootEntries = [entry('README.md'), entry('docs', true), entry('desktop', true), entry('.gitignore')];
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { fs.listDir.mockReset().mockResolvedValue(rootEntries); });
afterEach(cleanup);

describe('Workspace file tree', () => {
  it('distinguishes loading from empty and sorts directories before files using natural names', async () => {
    const pending = deferred<DirEntry[]>();
    fs.listDir.mockReturnValue(pending.promise);
    render(<WorkspaceTree root={root} />);
    expect(screen.getByRole('status').textContent).toContain('正在加载');
    expect(screen.queryByText('此文件夹为空')).toBeNull();
    expect((screen.getByRole('button', { name: '刷新文件' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve([entry('chapter10.md'), entry('chapter2.md'), entry('docs', true), entry('.gitignore')]));
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual(['docs', '.gitignore', 'chapter2.md', 'chapter10.md']);
    expect(screen.getByRole('button', { name: '项目文件：trylo' }).title).toBe(root);
  });

  it('loads a directory on first expansion, caches it through collapse and refreshes its descendants', async () => {
    fs.listDir.mockImplementation(async (path: FilePath) => path === root ? rootEntries : [entry('App.tsx', false, path)]);
    render(<WorkspaceTree root={root} />);
    const folder = await screen.findByRole('treeitem', { name: 'desktop' });
    expect(fs.listDir).toHaveBeenCalledTimes(1);
    fireEvent.click(folder);
    await screen.findByRole('treeitem', { name: 'App.tsx' });
    fireEvent.click(folder);
    expect(screen.queryByRole('treeitem', { name: 'App.tsx' })).toBeNull();
    fireEvent.click(folder);
    expect(screen.getByRole('treeitem', { name: 'App.tsx' })).toBeTruthy();
    expect(fs.listDir).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '刷新文件' }));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'desktop' }));
    await screen.findByRole('treeitem', { name: 'App.tsx' });
    expect(fs.listDir).toHaveBeenCalledTimes(4);
  });

  it('preserves the exact full path and exposes one selected row without opening directories as files', async () => {
    const select = vi.fn();
    fs.listDir.mockImplementation(async (path: FilePath) => path === root ? rootEntries : []);
    render(<WorkspaceTree root={root} onSelect={select} />);
    fireEvent.click(await screen.findByRole('treeitem', { name: 'desktop' }));
    await screen.findByText('此文件夹为空');
    expect(select).not.toHaveBeenCalled();
    const row = screen.getByRole('treeitem', { name: 'README.md' });
    fireEvent.click(row);
    expect(select).toHaveBeenCalledWith(`${root}/README.md`, 'file');
    expect(row.title).toBe(`${root}/README.md`);
    expect(screen.getAllByRole('treeitem', { selected: true })).toEqual([row]);
  });

  it('uses arrows for visible hierarchy navigation and leaves file activation to Enter/Space', async () => {
    const select = vi.fn();
    fs.listDir.mockImplementation(async (path: FilePath) => path === root ? rootEntries
      : path.endsWith('/desktop') ? [entry('src', true, path)] : [entry('App.tsx', false, path)]);
    render(<WorkspaceTree root={root} onSelect={select} />);
    const folder = await screen.findByRole('treeitem', { name: 'desktop' });
    act(() => folder.focus());
    fireEvent.keyDown(folder, { key: 'ArrowRight' });
    const nested = await screen.findByRole('treeitem', { name: 'src' });
    fireEvent.keyDown(folder, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(nested);
    fireEvent.keyDown(nested, { key: 'ArrowRight' });
    const child = await screen.findByRole('treeitem', { name: 'App.tsx' });
    fireEvent.keyDown(nested, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(nested);
    fireEvent.keyDown(nested, { key: 'ArrowLeft' });
    fireEvent.keyDown(nested, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(folder);
    fireEvent.keyDown(folder, { key: 'ArrowLeft' });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(folder, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('docs');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('README.md');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(folder);
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps the actual root error visible and allows retry before showing an honest empty state', async () => {
    fs.listDir.mockRejectedValueOnce(Error('Access denied: D:/CC/trylo')).mockResolvedValueOnce([]);
    render(<WorkspaceTree root={root} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Access denied: D:/CC/trylo');
    expect(screen.queryByText('此文件夹为空')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('此文件夹为空');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries a failed child directory without losing the expanded parent', async () => {
    fs.listDir.mockResolvedValueOnce(rootEntries).mockRejectedValueOnce(Error('Directory unavailable')).mockResolvedValueOnce([entry('App.tsx', false, `${root}/desktop` as FilePath)]);
    render(<WorkspaceTree root={root} />);
    const folder = await screen.findByRole('treeitem', { name: 'desktop' });
    fireEvent.click(folder);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('treeitem', { name: 'App.tsx' });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(fs.listDir.mock.calls.map(call => call[0])).toEqual([root, `${root}/desktop`, `${root}/desktop`]);
  });

  it('ignores an older request after switching workspaces', async () => {
    const old = deferred<DirEntry[]>();
    fs.listDir.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('new.md', false, 'D:/new' as FilePath)]);
    const { rerender } = render(<WorkspaceTree root={root} />);
    rerender(<WorkspaceTree root={'D:/new' as FilePath} />);
    await screen.findByRole('treeitem', { name: 'new.md' });
    await act(async () => old.resolve([entry('old.md')]));
    expect(screen.queryByRole('treeitem', { name: 'old.md' })).toBeNull();
    expect(screen.getByRole('button', { name: '项目文件：new' })).toBeTruthy();
  });

  it('collapses loaded folders together and keeps root collapse independent of the cache', async () => {
    fs.listDir.mockImplementation(async (path: FilePath) => path === root ? rootEntries : [entry('result.md', false, path)]);
    render(<WorkspaceTree root={root} />);
    const folder = await screen.findByRole('treeitem', { name: 'desktop' });
    fireEvent.click(folder);
    await screen.findByRole('treeitem', { name: 'result.md' });
    const toggle = screen.getByRole('button', { name: '项目文件：trylo' });
    fireEvent.click(toggle);
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('treeitem', { name: 'result.md' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '折叠所有文件夹' }));
    await waitFor(() => expect(folder.getAttribute('aria-expanded')).toBe('false'));
    expect(within(screen.getByRole('tree')).queryByRole('treeitem', { name: 'result.md' })).toBeNull();
    expect(fs.listDir).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('treeitem').filter(row => row.tabIndex === 0)).toHaveLength(1);
  });
});
