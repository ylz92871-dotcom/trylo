import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { InputBar } from './InputBar';
import { detectTriggerAtCaret } from './caret-position';
import { invalidateWorkspaceFileIndex } from '../command-palette/workspace-file-index';
import type { FilePath } from '../../host-adapter/types';

const listDirMock = vi.hoisted(() => vi.fn());

vi.mock('../../host-adapter', () => ({
  hostAdapter: {
    fs: {
      listDir: listDirMock,
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateWorkspaceFileIndex();
  listDirMock.mockResolvedValue([
    { name: 'README.md', path: '/tmp/ws/README.md' as FilePath, isDirectory: false },
    { name: 'report.docx', path: '/tmp/ws/report.docx' as FilePath, isDirectory: false },
  ]);
});

afterEach(() => {
  cleanup();
});

function ComposerHarness(props: {
  readonly kind: 'code' | 'work';
  readonly draft?: string;
  readonly onCompact?: () => void;
  readonly onCodeModeChange?: (mode: 'agent' | 'chat' | 'plan' | 'cognition') => void;
}): ReactElement {
  const [text, setText] = useState('');
  return (
    <InputBar
      conversationKind={props.kind}
      codeMode="agent"
      onCodeModeChange={props.onCodeModeChange ?? vi.fn()}
      text={props.draft ?? text}
      onTextChange={setText}
      onSend={vi.fn()}
      messages={[]}
      running={false}
      workspace="/tmp/ws"
      permissionLevel="ask"
      permissionSource="settings"
      onPermissionLevelChange={vi.fn()}
      contextUsed={0}
      contextWindow={100_000}
      model="claude"
      onCompact={props.onCompact ?? vi.fn()}
      compacting={false}
      compactAvailable={false}
      activeProcessId={null}
      attachments={[]}
      onAddAttachment={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />
  );
}

describe('detectTriggerAtCaret', () => {
  it('detects @ and / only at start or after whitespace', () => {
    expect(detectTriggerAtCaret('@rea', 4)).toEqual({ trigger: '@', query: 'rea', start: 0, end: 4 });
    expect(detectTriggerAtCaret('check @src/a', 12)).toEqual({ trigger: '@', query: 'src/a', start: 6, end: 12 });
    expect(detectTriggerAtCaret('a@b', 3)).toBeNull();
    expect(detectTriggerAtCaret('/pl', 3)).toEqual({ trigger: '/', query: 'pl', start: 0, end: 3 });
  });
});

describe('CaretSuggestions in Code & Work InputBar', () => {
  it.each(['code', 'work'] as const)('uses the settled caret after typing in %s', kind => {
    render(<ComposerHarness kind={kind} draft="/" />);
    const field = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    act(() => { field.setSelectionRange(0, 0); field.focus(); });
    expect(screen.queryByRole('listbox', { name: '快捷斜杠指令' })).not.toBeInTheDocument();
    field.setSelectionRange(1, 1);
    fireEvent.keyUp(field, { key: '/' });
    expect(screen.getByRole('option', { name: /\/goal/ })).toBeInTheDocument();
    expect(field.value).toBe('/');
  });

  it.each(['code', 'work'] as const)('reconciles a focused draft supplied by the host in %s', async kind => {
    const view = render(<ComposerHarness kind={kind} draft="" />);
    const field = screen.getByRole('textbox', { name: 'Message' });
    act(() => field.focus());
    view.rerender(<ComposerHarness kind={kind} draft="/" />);
    await waitFor(() => expect(screen.getByRole('option', { name: /\/goal/ })).toBeInTheDocument());
    expect(field).toHaveFocus();
  });

  it.each(['code', 'work'] as const)(
    'inserts @ file reference in %s mode while preserving IME and filtering stale scans',
    async (kind) => {
      let resolveSlow!: (entries: { name: string; path: FilePath; isDirectory: boolean }[]) => void;
      listDirMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      );

      render(<ComposerHarness kind={kind} />);
      const textarea = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

      // Type '@' to trigger async workspace file listing.
      fireEvent.change(textarea, { target: { value: '请看 @', selectionStart: 4 } });
      expect(screen.getByRole('listbox', { name: '引用工作区文件' })).toBeInTheDocument();

      await act(async () => {
        resolveSlow([
          { name: 'README.md', path: '/tmp/ws/README.md' as FilePath, isDirectory: false },
          { name: 'report.docx', path: '/tmp/ws/report.docx' as FilePath, isDirectory: false },
        ]);
      });

      await waitFor(() => {
        expect(screen.getByRole('option', { name: /README\.md/ })).toBeInTheDocument();
      });

      // IME Enter must NOT select/insert suggestion prematurely.
      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true, keyCode: 229 });
      expect(textarea.value).toBe('请看 @');

      // ArrowDown + Enter selects report.docx and replaces '@'.
      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('请看 @report.docx ');
    },
  );

  it('shows slash suggestions with disabled reason and triggers mode switch on Enter', () => {
    const onCodeModeChange = vi.fn();
    render(<ComposerHarness kind="code" onCodeModeChange={onCodeModeChange} />);
    const textarea = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/comp', selectionStart: 5 } });
    const compactOption = screen.getByRole('option', { name: /\/compact/ });
    expect(compactOption).toHaveAttribute('aria-disabled', 'true');
    expect(compactOption).toHaveTextContent('当前无活跃对话进程可压缩');

    fireEvent.change(textarea, { target: { value: '/plan', selectionStart: 5 } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onCodeModeChange).toHaveBeenCalledWith('plan');
    expect(textarea.value).toBe('');
  });
});
