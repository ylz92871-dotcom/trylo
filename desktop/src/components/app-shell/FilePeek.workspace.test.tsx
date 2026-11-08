import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../work/tryloHostAdapter', () => ({ createTryloHostAdapter: () => ({}) }));
vi.mock('../../host-adapter/preview/office-pages', () => ({ invalidateOfficePages: vi.fn() }));
vi.mock('../../host-adapter/tauri-detect', () => ({ isTauri: () => false }));
vi.mock('../preview', () => ({
  previewKindFor: () => 'image', previewKindLabel: () => 'Image',
  PreviewRouter: ({ allowedRoot }: { allowedRoot?: string }) => {
    if (allowedRoot === 'D:/broken') throw new Error('previous workspace renderer failed');
    return <p>current workspace image</p>;
  },
}));
import { FilePeek } from './FilePeek';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('recovers from a renderer error when the same relative path opens in another workspace', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const view = render(<FilePeek path="same.png" content="" allowedRoot="D:/broken" onClose={vi.fn()} />);
  expect(screen.getByText('previous workspace renderer failed')).toBeTruthy();
  view.rerender(<FilePeek path="same.png" content="" allowedRoot="D:/healthy" onClose={vi.fn()} />);
  expect(screen.queryByText('previous workspace renderer failed')).toBeNull();
  expect(screen.getByText('current workspace image')).toBeTruthy();
});

it('keeps the current file name when it is outside the deliverable list and switches to a listed result', () => {
  const select = vi.fn();
  render(<FilePeek path="notes/extra.png" content="" allowedRoot="D:/healthy" onClose={vi.fn()}
    files={[{ path: 'result/one.png' }, { path: 'result/two.png' }]} onSelectFile={select} />);
  const picker = screen.getByRole('combobox', { name: '成果文件' });
  expect((picker as HTMLSelectElement).value).toBe('notes/extra.png');
  expect(screen.getByRole('option', { selected: true }).textContent).toBe('extra.png');
  fireEvent.change(picker, { target: { value: 'result/two.png' } });
  expect(select).toHaveBeenCalledWith('result/two.png');
});
