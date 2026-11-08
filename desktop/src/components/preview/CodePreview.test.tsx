import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ init: vi.fn(), create: vi.fn(), model: vi.fn(), dispose: vi.fn(), releaseModel: vi.fn(), find: vi.fn(), options: vi.fn(), setLanguage: vi.fn(), setTheme: vi.fn() }));
vi.mock('../../monaco-init', () => ({ initMonaco: mock.init }));
vi.mock('../../preview/providers/source-highlighting', () => ({ registerPreviewLanguages: vi.fn() }));
vi.mock('../../settings/appearance-store', () => ({ useAppearance: () => ({ theme: 'dark' }) }));
vi.mock('monaco-editor', () => ({ editor: { createModel: mock.model, create: mock.create, setModelLanguage: mock.setLanguage, setTheme: mock.setTheme, defineTheme: vi.fn() } }));
import { CodePreview } from './CodePreview';
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('uses a separate read-only model, supports reading controls and disposes it on close', async () => {
  const content = 'print("hello")\n# last-line';
  const model = { getValue: () => content, setValue: vi.fn(), getLineCount: () => 2, dispose: mock.releaseModel };
  mock.init.mockResolvedValue(undefined); mock.model.mockReturnValue(model);
  mock.create.mockReturnValue({ dispose: mock.dispose, getModel: () => model, updateOptions: mock.options, focus: vi.fn(), getAction: () => ({ run: mock.find }), revealLineInCenter: vi.fn(), setPosition: vi.fn(), onDidChangeCursorPosition: vi.fn() });
  const view = render(<CodePreview path="main.py" content={content} />);
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
  expect(mock.model).toHaveBeenCalledWith(content, 'python');
  expect(mock.create.mock.calls[0]?.[1]).toMatchObject({ readOnly: true, domReadOnly: true, renderValidationDecorations: 'off' });
  fireEvent.click(screen.getByRole('button', { name: '自动换行' }));
  await waitFor(() => expect(mock.options).toHaveBeenCalledWith({ wordWrap: 'on' }));
  fireEvent.change(screen.getByRole('combobox', { name: '代码语言' }), { target: { value: 'rust' } });
  await waitFor(() => expect(mock.setLanguage).toHaveBeenCalledWith(model, 'rust'));
  fireEvent.click(screen.getByRole('button', { name: '查找' })); expect(mock.find).toHaveBeenCalled();
  view.unmount(); expect(mock.dispose).toHaveBeenCalledTimes(1); expect(mock.releaseModel).toHaveBeenCalledTimes(1);
});

it('does not create a late editor after the reader is closed while loading', async () => {
  let ready!: () => void; mock.init.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
  const view = render(<CodePreview path="main.ts" content="export const answer = 42" />);
  view.unmount(); ready();
  await Promise.resolve(); await Promise.resolve();
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.model).not.toHaveBeenCalled();
});
it('keeps the reader usable when the clipboard API is absent', async () => {
  mock.init.mockImplementation(() => new Promise<void>(() => {}));
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  try {
    render(<CodePreview path="source.py" content="print(42)" />);
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));
    await screen.findByText('复制失败，请在阅读器内选中后复制。');
    expect(screen.getByRole('combobox', { name: '代码语言' })).toBeTruthy();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('retains the load error and recovers on an explicit retry without altering file content', async () => {
  const failure = new TypeError('Failed to fetch dynamically imported module: /deps/monaco-editor.js?v=expired');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const content = 'export const answer = 42;';
  const model = { getValue: () => content, setValue: vi.fn(), dispose: mock.releaseModel };
  mock.init.mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  mock.model.mockReturnValue(model);
  mock.create.mockReturnValue({ dispose: mock.dispose, getModel: () => model, updateOptions: mock.options, onDidChangeCursorPosition: vi.fn() });
  try {
    render(<CodePreview path="answer.ts" content={content} />);
    await screen.findByText('高亮阅读器未能加载，已切换为全文阅读。');
    expect(screen.getByText(failure.message)).toBeTruthy();
    expect(warning).toHaveBeenCalledWith('[CodePreview] Highlighter initialization failed', failure);
    expect(mock.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试高亮' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '代码阅读器' }).getAttribute('aria-busy')).toBe('false'));
    expect(mock.init).toHaveBeenCalledTimes(2);
    expect(mock.model).toHaveBeenCalledWith(content, 'typescript');
    expect(screen.queryByText(failure.message)).toBeNull();
  } finally { warning.mockRestore(); }
});

it('releases a partially created model when editor creation fails before retry', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mock.init.mockResolvedValue(undefined);
  mock.model.mockReturnValue({ dispose: mock.releaseModel });
  mock.create.mockImplementation(() => { throw Error('Editor creation failed'); });
  try {
    const view = render(<CodePreview path="answer.ts" content="export const answer = 42;" />);
    await screen.findByRole('button', { name: '重试高亮' });
    expect(screen.getByText('Editor creation failed')).toBeTruthy();
    expect(mock.releaseModel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mock.releaseModel).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});
