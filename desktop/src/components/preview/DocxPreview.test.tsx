import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ bytes: new Uint8Array([1,2,3]), read: vi.fn(), render: vi.fn() }));
vi.mock('./usePreviewBytes', () => ({ usePreviewBytes: (...args: unknown[]) => { mock.read(...args); return { status: 'ready', bytes: mock.bytes }; } }));
vi.mock('docx-preview', () => ({ renderAsync: mock.render }));
import { DocxPreview } from './DocxPreview';
beforeEach(() => { mock.render.mockImplementation(async (_input: Blob, target: HTMLElement) => { target.textContent = 'Document body'; }); });
afterEach(() => { cleanup(); mock.read.mockReset(); mock.render.mockReset(); });
it('passes the selected project to the byte loader and renders the actual completed body', async () => {
  render(<DocxPreview path="notes.docx" allowedRoot="D:/project" />);
  await screen.findByText('Document body');
  expect(mock.read).toHaveBeenCalledWith('notes.docx', undefined, 'D:/project');
  expect(screen.queryByRole('status')).toBeNull();
});
it('can retry rendering after a layout failure without losing the target container', async () => {
  mock.render.mockRejectedValueOnce(new Error('temporary renderer failure'));
  render(<DocxPreview path="notes.docx" allowedRoot="D:/project" />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重试排版' }));
  await screen.findByText('Document body'); expect(mock.render).toHaveBeenCalledTimes(2);
});
it('does not paint a late document result into a different workspace', async () => {
  let finish!: () => void;
  mock.render.mockImplementationOnce((_input: Blob, target: HTMLElement) => new Promise<void>(resolve => { finish = () => { target.textContent = 'Old workspace'; resolve(); }; }));
  const view = render(<DocxPreview path="same.docx" allowedRoot="D:/one" />);
  await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(1));
  view.rerender(<DocxPreview path="same.docx" allowedRoot="D:/two" />);
  await screen.findByText('Document body'); finish();
  await Promise.resolve(); expect(screen.queryByText('Old workspace')).toBeNull();
});
