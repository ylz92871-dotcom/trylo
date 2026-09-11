// Trylo Desktop — AttachmentList tests. See v1.16.2.

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentList } from './AttachmentList';
import type { Attachment, FailedAttachment } from '../../host-adapter/attachment-utils';

function att(over: Partial<Attachment>): Attachment {
  return {
    id: 'a1',
    kind: 'text',
    name: 'notes.md',
    path: 'C:/ws/notes.md',
    size: 1024,
    mediaType: '',
    excerpt: 'hello',
    addedAt: 1,
    ...over,
  };
}

describe('AttachmentList', () => {
  it('renders nothing when the list is empty', () => {
    const { container } = render(
      <AttachmentList attachments={[]} onRemove={vi.fn()} />,
    );
    expect(container.querySelector('.attachment-list')).toBeNull();
  });

  it('renders one chip per attachment', () => {
    const attachments: Attachment[] = [
      att({ id: '1', kind: 'office', name: 'contract.docx', size: 15_000 }),
      att({ id: '2', kind: 'image', name: 'shot.png', size: 200_000 }),
      att({ id: '3', kind: 'text', name: 'notes.md', size: 4_000 }),
    ];
    render(<AttachmentList attachments={attachments} onRemove={vi.fn()} />);
    expect(screen.getByText('contract.docx')).toBeInTheDocument();
    expect(screen.getByText('shot.png')).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
  });

  it('picks the right icon per kind', () => {
    const attachments: Attachment[] = [
      att({ id: '1', kind: 'office', name: 'a.docx' }),
      att({ id: '2', kind: 'image', name: 'b.png' }),
      att({ id: '3', kind: 'text', name: 'c.md' }),
    ];
    const { container } = render(
      <AttachmentList attachments={attachments} onRemove={vi.fn()} />,
    );
    const chips = container.querySelectorAll('.attachment-chip');
    expect(chips[0]!.className).toContain('attachment-chip--office');
    expect(chips[1]!.className).toContain('attachment-chip--image');
    expect(chips[2]!.className).toContain('attachment-chip--text');
  });

  it('fires onRemove with the attachment id when × is clicked', () => {
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      att({ id: '1', name: 'first.docx' }),
      att({ id: '2', name: 'second.docx' }),
    ];
    render(<AttachmentList attachments={attachments} onRemove={onRemove} />);
    // The second chip's remove button.
    const removes = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removes[1]!);
    expect(onRemove).toHaveBeenCalledWith('2');
  });

  it('v1.16.2.6: shows a "Reading N file(s)…" placeholder when loading > 0', () => {
    render(
      <AttachmentList
        attachments={[]}
        onRemove={vi.fn()}
        loading={3}
      />,
    );
    expect(screen.getByText(/reading 3 files/i)).toBeInTheDocument();
  });

  it('v1.16.2.6: renders the loading chip + real chips together', () => {
    const attachments: Attachment[] = [
      att({ id: '1', name: 'a.md' }),
      att({ id: '2', name: 'b.md' }),
    ];
    render(
      <AttachmentList
        attachments={attachments}
        onRemove={vi.fn()}
        loading={1}
      />,
    );
    // Real chips
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('b.md')).toBeInTheDocument();
    // Loading chip
    expect(screen.getByText(/reading 1 file\b/i)).toBeInTheDocument();
  });

  it('v1.16.2.6: loading=0 is treated like no loading state', () => {
    const { container } = render(
      <AttachmentList attachments={[]} onRemove={vi.fn()} loading={0} />,
    );
    expect(container.querySelector('.attachment-list')).toBeNull();
  });

  // P2-1 Work Package B: failed-chip retry affordance.
  function failed(over: Partial<FailedAttachment>): FailedAttachment {
    return { id: 'f1', name: 'a.md', path: 'D:/ext/a.md', reason: 'io error', ...over };
  }

  it('shows a retry button only for retryable failures', () => {
    render(
      <AttachmentList
        attachments={[]}
        onRemove={vi.fn()}
        failed={[failed({ id: 'f1', retryable: true }), failed({ id: 'f2', name: 'b.md' })]}
        onRetryFailed={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry a.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry b.md' })).toBeNull();
  });

  it('fires onRetryFailed with the failure id when ↻ is clicked', () => {
    const onRetryFailed = vi.fn();
    render(
      <AttachmentList
        attachments={[]}
        onRemove={vi.fn()}
        failed={[failed({ retryable: true })]}
        onRetryFailed={onRetryFailed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry a.md' }));
    expect(onRetryFailed).toHaveBeenCalledWith('f1');
  });

  it('never shows a retry button when no retry handler is wired', () => {
    render(
      <AttachmentList
        attachments={[]}
        onRemove={vi.fn()}
        failed={[failed({ retryable: true })]}
      />,
    );
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
