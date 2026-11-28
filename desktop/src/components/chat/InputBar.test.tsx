import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InputBar, type InputBarProps } from './InputBar';

function props(overrides: Partial<InputBarProps> = {}): InputBarProps {
  return {
    codeMode: 'agent',
    onCodeModeChange: vi.fn(),
    onSend: vi.fn(),
    text: '',
    onTextChange: vi.fn(),
    messages: [],
    running: false,
    contextUsed: 0,
    contextWindow: 200_000,
    model: 'test',
    compacting: false,
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onCompact: vi.fn(),
    activeProcessId: null,
    // P2 (spec §3.2): the new chip is required and the
    // picker is a controlled component. Tests pass a known
    // level + a stub change handler.
    permissionLevel: 'workspace_write',
    permissionSource: 'settings',
    onPermissionLevelChange: vi.fn(),
    ...overrides,
  };
}

describe('InputBar conversation kind', () => {
  it('waits for pasted files before accepting Enter or a send click', () => {
    const onSend = vi.fn();
    render(<InputBar {...props({ text: '对比图片', attachmentLoading: 1, onSend })} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
  it.each(['code', 'work'] as const)('accepts clipboard images once in %s while preserving mixed text', conversationKind => {
    const onPasteAttachments = vi.fn();
    const onTextChange = vi.fn();
    render(<InputBar {...props({ conversationKind, text: '前面后面', onPasteAttachments, onTextChange })} />);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    input.setSelectionRange(2, 2);
    const file = new File(['image'], '截图.png', { type: 'image/png' });
    const defaultAllowed = fireEvent.paste(input, { clipboardData: {
      files: [file], items: [{ kind: 'file', getAsFile: () => file }], getData: () => '说明',
    } });
    expect(defaultAllowed).toBe(false);
    expect(onPasteAttachments).toHaveBeenCalledTimes(1);
    expect(onPasteAttachments).toHaveBeenCalledWith([file]);
    expect(onTextChange).toHaveBeenCalledWith('前面说明后面');
  });
  it('uses clipboard items when files is empty, and leaves ordinary text paste to the browser', () => {
    const onPasteAttachments = vi.fn();
    render(<InputBar {...props({ onPasteAttachments })} />);
    const input = screen.getByRole('textbox', { name: 'Message' });
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    expect(fireEvent.paste(input, { clipboardData: {
      files: [], items: [{ kind: 'file', getAsFile: () => file }], getData: () => '',
    } })).toBe(false);
    expect(onPasteAttachments).toHaveBeenCalledWith([file]);
    expect(fireEvent.paste(input, { clipboardData: {
      files: [], items: [{ kind: 'string' }], getData: () => '普通文本',
    } })).toBe(true);
    expect(onPasteAttachments).toHaveBeenCalledTimes(1);
  });
  it('routes a goal command from the send button to the same setup as Enter', () => {
    const onSend = vi.fn();
    render(<InputBar {...props({ conversationKind: 'work', text: '/goal 修复发送', onSend, onGoalAction: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect((screen.getByLabelText('目标') as HTMLTextAreaElement).value).toBe('修复发送');
    expect(onSend).not.toHaveBeenCalled();
  });
  it.each(['work', 'code'] as const)('sends a fresh %s conversation exactly once by click', conversationKind => {
    const onSend = vi.fn();
    const view = render(<InputBar {...props({ conversationKind, onSend, onGoalAction: vi.fn() })} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<InputBar {...props({ conversationKind, text: '  你好  ', onSend, onGoalAction: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('你好');
  });
  it('routes the goal command to explicit setup instead of sending a model prompt', () => {
    const onSend = vi.fn();
    render(<InputBar {...props({ text: '/goal 完成当前验收', onSend, onGoalAction: vi.fn() })} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect((screen.getByLabelText('目标') as HTMLTextAreaElement).value).toBe('完成当前验收');
    expect(onSend).not.toHaveBeenCalled();
  });
  it('opens goal setup from the add menu and preserves ordinary message sending', () => {
    const onGoalAction = vi.fn().mockResolvedValue(undefined);
    const onSend = vi.fn();
    render(<InputBar {...props({ text: '当前聊天的草稿', onGoalAction, onSend })} />);
    fireEvent.click(screen.getByRole('button', { name: '添加和设置' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /设置目标/ }));
    expect((screen.getByLabelText('目标') as HTMLTextAreaElement).value).toBe('当前聊天的草稿');
    fireEvent.click(screen.getByRole('button', { name: '关闭目标编辑' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('当前聊天的草稿');
    expect(onGoalAction).not.toHaveBeenCalled();
  });
  it('blocks both keyboard and form submission when sending is unavailable', () => {
    const onSend = vi.fn();
    const { container } = render(<InputBar {...props({ text: 'pending attachment', canSend: false, onSend })} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSend).not.toHaveBeenCalled();
  });
  it('replaces stop with send while typing during a run and restores it when cleared', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const view = render(<InputBar {...props({ text: 'change direction', running: true, onSend, onStop })} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^发送/ })).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('change direction');
    view.rerender(<InputBar {...props({ text: '  ', running: true, onSend, onStop })} />);
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    view.rerender(<InputBar {...props({ text: '', running: false, onSend, onStop })} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '发送' })).toHaveLength(1);
  });
  it('puts one working stop control in the composer even when sending is blocked', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    const view = render(<InputBar {...props({ running: true, onStop, onSend, canSend: false })} />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.closest('form')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '发送（可排队或打断）' })).toBeNull();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    view.rerender(<InputBar {...props({ running: false, onStop })} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
  });
  it('keeps Code-specific controls in a Code conversation', () => {
    render(<InputBar {...props()} />);

    expect(screen.getByRole('button', { name: '任务类型: Code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
  });

  it('shows a Work marker without inert Code controls in a Work conversation', () => {
    render(<InputBar {...props({ conversationKind: 'work' })} />);

    expect(screen.getByRole('button', { name: '任务类型: Work' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Code sub-mode/ })).toBeNull();
    // P2-1 Work Package B: Work gained full attachment capability —
    // the SAME button + AttachmentList as Code (no second copy).
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    // M4-D: Work's placeholder is capability-neutral; the
    // previous "document / spreadsheet / presentation / web
    // page" copy implied Work was an Office generator.
    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toBe('描述你想完成的工作，或添加资料…');
  });

  it('keeps the composer active and explains steering while a run is active', () => {
    render(
      <InputBar
        {...props({
          conversationKind: 'work',
          running: true,
          canSend: true,
        })}
      />,
    );

    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toBe('输入调整方向，Enter 发送后续消息…');
    // Without a stop capability the send arrow remains available.
    expect(screen.getByRole('button', { name: '发送（可排队或打断）' })).toBeTruthy();
  });

  it('renders the User Learning chip on the action row', () => {
    render(
      <InputBar
        {...props({
          learning: {
            mode: 'shadow',
            evidenceCount: 3,
            modelCount: 1,
            injected: false,
            onOpen: vi.fn(),
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '学习与协作选项' }));
    expect(screen.getByRole('button', { name: 'User Learning shadow, Evidence 3' })).toBeTruthy();
  });

  it('uses the Cognition composer placeholder', () => {
    render(<InputBar {...props({ codeMode: 'cognition' })} />);
    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toContain('说说你希望 Trylo 怎样与你合作');
  });

  it('shows the tool-profile chip in Work only (which MCP servers this run sees)', () => {
    const { unmount } = render(
      <InputBar {...props({ conversationKind: 'work', toolProfileId: 'work.cad.v1' })} />,
    );
    expect(screen.getByRole('button', { name: /工具面：work\.cad\.v1/ }).textContent).toContain('CAD');
    unmount();
    // Code mounts no trylo servers — no chip even if a stale id lingers.
    render(<InputBar {...props()} />);
    expect(screen.queryByRole('button', { name: /工具面/ })).toBeNull();
  });
});

it('keeps the composer stop control without the retired Turn/tools status row', () => {
  const view = render(<InputBar {...props({ running: true, viewState: 'thinking', onStop: vi.fn(), activeProcessId: 'run' })} />);
  expect(view.container.querySelector('.process-header')).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
});

it('uses macOS Return glyph in send hint and steering placeholder when running on macOS', () => {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  try {
    const view = render(<InputBar {...props({ running: true, canSend: true })} />);
    expect(view.container.querySelector('.input-bar__hint')?.textContent).toBe('↩ 发送');
    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toBe('输入调整方向，↩ 发送后续消息…');
  } finally {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  }
});
