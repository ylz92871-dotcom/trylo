import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ init: vi.fn(), model: vi.fn(), create: vi.fn(), release: vi.fn(), dispose: vi.fn(), language: vi.fn(), value: '' }));
vi.mock('../../monaco-init', () => ({ initMonaco: mock.init }));
vi.mock('../../preview/providers/source-highlighting', () => ({ registerPreviewLanguages: vi.fn() }));
vi.mock('../../settings/appearance-store', () => ({ useAppearance: () => ({ theme: 'light' }) }));
vi.mock('monaco-editor', () => ({ editor: {
  createModel: mock.model, create: mock.create, setModelLanguage: mock.language, setTheme: vi.fn(), defineTheme: vi.fn(),
} }));
vi.mock('./InteractiveWebPreview', () => ({ InteractiveWebPreview: () => <div>Interactive page</div> }));
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';

beforeEach(() => {
  mock.init.mockResolvedValue(undefined);
  mock.model.mockImplementation((content: string) => {
    mock.value = content;
    return { getValue: () => mock.value, setValue: (value: string) => { mock.value = value; }, dispose: mock.release };
  });
  mock.create.mockImplementation(() => ({
    getModel: () => mock.model.mock.results.at(-1)?.value, dispose: mock.dispose,
    updateOptions: vi.fn(), onDidChangeCursorPosition: vi.fn(),
  }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('opens HTML source with the actual HTML reader model and preserves embedded CSS and JavaScript', async () => {
  const content = '<!doctype html><style>body { color: #ff6699; }</style><script>const answer = 42;</script><h1>Hello</h1>';
  const view = render(<HtmlPreview title="D:/project/index.html" content={content} />);
  expect(mock.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  await screen.findByRole('region', { name: '代码阅读器' });
  await waitFor(() => expect(mock.model).toHaveBeenCalledWith(content, 'html'));
  expect(mock.create.mock.calls[0]?.[1]).toMatchObject({ readOnly: true, domReadOnly: true });
  expect((screen.getByRole('combobox', { name: '代码语言' }) as HTMLSelectElement).value).toBe('html');
  const updated = content.replace('42', '43');
  view.rerender(<HtmlPreview title="D:/project/index.html" content={updated} />);
  await waitFor(() => expect(mock.value).toBe(updated));
  expect(mock.create).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '交互预览' }));
  expect(mock.dispose).toHaveBeenCalledTimes(1);
  expect(mock.release).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Interactive page')).toBeTruthy();
});

it('uses the same code reader for Markdown source and returns to rendered reading', async () => {
  const content = '# Heading\n\n[Link](https://example.com)\n\n```js\nconst answer = 42;\n```';
  render(<MarkdownPreview path="D:/project/README.md" content={content} />);
  expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
  expect(mock.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  await screen.findByRole('region', { name: '代码阅读器' });
  await waitFor(() => expect(mock.model).toHaveBeenCalledWith(content, 'markdown'));
  fireEvent.click(screen.getByRole('button', { name: '阅读' }));
  expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
  expect(mock.release).toHaveBeenCalledTimes(1);
});

it('recognizes Markdown source even when the caller has no file path', async () => {
  render(<MarkdownPreview content="# Untitled" />);
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  await screen.findByRole('region', { name: '代码阅读器' });
  await waitFor(() => expect(mock.model).toHaveBeenCalledWith('# Untitled', 'markdown'));
});
