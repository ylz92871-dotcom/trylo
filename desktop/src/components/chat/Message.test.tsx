import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message } from './Message';
import type { TurnMessage } from './types';

describe('user message edit availability', () => {
  const message = { id: 'edit-user', kind: 'text' as const, role: 'user' as const,
    text: '原始问题', createdAt: 1 };

  it('does not advertise editing without an actual host callback', () => {
    const view = render(<Message message={message} />);
    const bubble = view.container.querySelector<HTMLElement>('.message__bubble')!;
    expect(bubble.getAttribute('title')).toBeNull();
    expect(bubble.getAttribute('role')).not.toBe('button');
    expect(bubble.getAttribute('tabindex')).toBeNull();
    expect(bubble.style.cursor).toBe('');
    view.unmount();
  });

  it('opens an available edit action with either Enter or Space', () => {
    const edit = vi.fn();
    const view = render(<Message message={message} onEditMessage={edit} />);
    const bubble = view.getByRole('button', { name: '原始问题' });
    expect(bubble.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(bubble, { key: 'Enter' });
    fireEvent.keyDown(bubble, { key: ' ' });
    expect(edit.mock.calls).toEqual([['edit-user'], ['edit-user']]);
    view.unmount();
  });
});

/** Round-3 (P1-11): a turn row, defaulted to a healthy finished turn. */
function turnMessage(over: Partial<TurnMessage> = {}): TurnMessage {
  return { id: 'turn-1', kind: 'turn', role: 'assistant', createdAt: 10,
    turn: 1, depth: 0, agentId: null, status: 'done', stopReason: 'end_turn', ...over };
}

describe('Message assistant delivery', () => {
  it('renders the image a user sent inside the sent bubble', () => {
    render(
      <Message
        message={{
          id: 'user-1',
          kind: 'text',
          role: 'user',
          createdAt: 1,
          turnStartedAt: 1,
          text: '看下这张图',
          attachments: [
            { id: 'att-1', name: 'shot.png', kind: 'image', size: 2048, previewUrl: 'blob:x' },
            { id: 'att-2', name: 'plan.docx', kind: 'office', size: 512 },
          ],
        }}
      />,
    );
    // The image thumbnail shows the blob; the office file collapses to a chip.
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect(screen.getByText('plan.docx')).toBeTruthy();
    expect(screen.getByText('看下这张图')).toBeTruthy();
  });

  it('renders workspace file mentions as clickable artifact links', () => {
    const onOpenArtifact = vi.fn();

    render(
      <Message
        message={{
          id: 'answer-1',
          kind: 'text',
          role: 'assistant',
          createdAt: 1,
          text: '## 交付结果\n\n已生成 `slides\\变色小魔术_教案.md`。',
        }}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    expect(screen.getByRole('heading', { name: '交付结果' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'slides\\变色小魔术_教案.md' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('slides/变色小魔术_教案.md');
  });

  it('renders a Cognition prompt card in the stream', () => {
    render(
      <Message
        message={{
          id: 'cognition:s1',
          kind: 'cognition_prompt',
          role: 'system',
          createdAt: 1,
          sessionId: 's1',
          prompt: '核心路径是否仍要最终验证？',
          options: [],
          dimension: 'verification_audit',
          status: 'pending',
        }}
      />,
    );
    expect(screen.getByText('核心路径是否仍要最终验证？')).toBeTruthy();
    expect(screen.getByText('想确认一下')).toBeTruthy();
  });
});

describe('Message steer rows (Round-3 P0-5)', () => {
  // A guidance is visible but must never read as a normal user turn: it is
  // excluded from the turn boundary and from turnCount, so the flag on the
  // row is the ONLY thing telling the reader what this bubble is.
  it('marks a guidance that never landed', () => {
    const { container } = render(
      <Message
        message={{
          id: 'u-steer',
          kind: 'text',
          role: 'user',
          createdAt: 2,
          text: '停止重复运行同一条命令',
          steerState: 'failed',
        }}
      />,
    );
    expect(screen.getByText('停止重复运行同一条命令')).toBeTruthy();
    const flag = container.querySelector('[data-steer-state="failed"]');
    expect(flag).not.toBeNull();
    expect(flag?.textContent).toContain('引导未送达');
  });

  it('marks a guidance that reached the running task', () => {
    const { container } = render(
      <Message
        message={{
          id: 'u-steer-2',
          kind: 'text',
          role: 'user',
          createdAt: 2,
          text: '改用更简单的方法',
          steerState: 'delivered',
        }}
      />,
    );
    expect(screen.getByText('改用更简单的方法')).toBeTruthy();
    expect(container.querySelector('[data-steer-state="delivered"]')?.textContent).toContain(
      '已送入运行中的任务',
    );
  });

  it('keeps a real user bubble unflagged', () => {
    const { container } = render(
      <Message
        message={{ id: 'u-real', kind: 'text', role: 'user', createdAt: 1, text: '普通提问' }}
      />,
    );
    expect(container.querySelector('[data-steer-state]')).toBeNull();
  });
});

// The UI half of P1-11: the turn row is the only place this can surface, and
// it rendered NOTHING before (Message.tsx `case 'turn'` returned `<></>`).
describe('P1-11 — the transcript shows 本轮未完成', () => {
  it('renders nothing for a turn that delivered something', () => {
    render(<Message message={turnMessage({ stopReason: 'end_turn', status: 'done' })} />);
    expect(screen.queryByText(/本轮未完成/)).toBeNull();
  });

  it('renders 本轮未完成 for a turn that delivered nothing', () => {
    render(<Message message={turnMessage({ stopReason: 'failed', status: 'error', incomplete: true })} />);
    const row = screen.getByText(/本轮未完成/);
    expect(row).toBeTruthy();
    expect(screen.getByText(/运行未成功结束/)).toBeTruthy();
  });
});

it('presents a mid-stream network failure as readable feedback with exact diagnostics', () => {
  const raw = 'network - mid_stream:network - check connectivity and the endpoint, then retry - If this run was saved, continue in the same saved session from recorded tool results.';
  const view = render(<Message message={{ id: 'network', role: 'system', kind: 'notice', createdAt: 1, text: raw }} />);
  expect(screen.getByText('模型连接中断')).toBeTruthy();
  expect(view.container.querySelector('details')?.textContent).toContain(raw);
});
