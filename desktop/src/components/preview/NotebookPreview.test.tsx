import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./CodePreview', () => ({ CodePreview: ({ content }: { content: string }) => <pre>{content}</pre> }));
vi.mock('./TextPreview', () => ({ TextPreview: ({ content }: { content: string }) => <pre>{content}</pre> }));
import { NotebookPreview } from './NotebookPreview';
afterEach(cleanup);
it('makes the final saved cell and all of its outputs reachable without executing code', () => {
  const content = JSON.stringify({ nbformat: 4, cells: Array.from({ length: 21 }, (_, index) => ({ cell_type: 'code', source: `saved_${index + 1}`, outputs: index === 20 ? [{ output_type: 'stream', text: 'first output' }, { output_type: 'stream', text: 'final output' }] : [] })) });
  render(<NotebookPreview content={content} path="analysis.ipynb" allowedRoot="D:/project" />);
  expect(screen.getByText('saved_1')).toBeTruthy(); expect(screen.queryByText('saved_21')).toBeNull();
  fireEvent.change(screen.getByRole('spinbutton', { name: '跳至笔记本单元' }), { target: { value: '21' } });
  expect(screen.getByText('saved_21')).toBeTruthy(); expect(screen.getByText('first output')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一项输出' })); expect(screen.getByText('final output')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: '查找笔记本单元' }), { target: { value: 'saved_11' } });
  expect(screen.getByText('saved_11')).toBeTruthy(); expect(screen.queryByText('saved_21')).toBeNull();
});
