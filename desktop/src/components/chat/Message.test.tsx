import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message } from './Message';

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
