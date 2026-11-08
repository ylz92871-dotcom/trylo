import JSZip from 'jszip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ state: { status: 'ready' as const, bytes: new Uint8Array() } }));
vi.mock('./usePreviewBytes', () => ({ usePreviewBytes: () => mock.state }));
vi.mock('./TextPreview', () => ({ TextPreview: ({ content }: { content: string }) => <pre>{content}</pre> }));
vi.mock('./CodePreview', () => ({ CodePreview: ({ content }: { content: string }) => <pre>{content}</pre> }));
import { ArchivePreview } from './ArchivePreview';
afterEach(cleanup);
it('opens a real saved ZIP entry, returns to its directory and filters paths', async () => {
  const zip = new JSZip(); zip.file('src/tail.py', 'print("complete tail")'); zip.file('notes.txt', 'saved notes');
  mock.state = { status: 'ready', bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };
  render(<ArchivePreview path="outputs.zip" allowedRoot="D:/project" />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/tail.py' }));
  expect(await screen.findByText('print("complete tail")')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回目录' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '筛选归档路径' }), { target: { value: 'notes' } });
  expect(screen.getByRole('button', { name: 'notes.txt' })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'src/tail.py' })).toBeNull();
});
