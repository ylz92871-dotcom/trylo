import { render, screen } from '@testing-library/react';
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
  it('keeps Code-specific controls in a Code conversation', () => {
    render(<InputBar {...props()} />);

    expect(screen.getByRole('button', { name: 'Code sub-mode: Agent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
  });

  it('shows a Work marker without inert Code controls in a Work conversation', () => {
    render(<InputBar {...props({ conversationKind: 'work' })} />);

    expect(screen.getByLabelText('Work conversation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Code sub-mode/ })).toBeNull();
    // P2-1 Work Package B: Work gained full attachment capability —
    // the SAME button + AttachmentList as Code (no second copy).
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    // M4-D: Work's placeholder is capability-neutral; the
    // previous "document / spreadsheet / presentation / web
    // page" copy implied Work was an Office generator.
    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toBe('在当前工作区研究、整理或生成产物…');
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
    ).toBe('输入调整方向，Enter 立即引导当前任务…');
    // run-controls §UI-B: during a live turn the send slot stays the arrow
    // (messages QUEUE by default); the single Stop lives in the header.
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
    expect(screen.getByRole('button', { name: 'User Learning shadow, Evidence 3' })).toBeTruthy();
  });

  it('uses the Cognition composer placeholder', () => {
    render(<InputBar {...props({ codeMode: 'cognition' })} />);
    expect(
      screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder'),
    ).toContain('Tell Trylo how you like to work');
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
