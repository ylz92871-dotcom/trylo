import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SkillsModal } from './SkillsModal';
import type { LearningPort } from '../../learning/learning-port';

afterEach(() => cleanup());

function fakePort(over: Record<string, unknown> = {}): LearningPort {
  return {
    skills: vi.fn(async (params: { op?: string; name?: string }) => {
      if (params.op === 'view') {
        return { ok: true, content: `# ${params.name}\n\nfull skill body` };
      }
      return {
        ok: true,
        skills: [
          { name: 'pptx-to-lesson-plan', category: 'teaching', description: 'read PPT, write lesson plan' },
          { name: 'trylo-desktop-companion', category: 'desktop', description: 'pet sidecar architecture' },
        ],
      };
    }),
    ...over,
  } as unknown as LearningPort;
}

describe('SkillsModal', () => {
  it('renders nothing when closed', () => {
    render(<SkillsModal open={false} port={fakePort()} onClose={() => {}} />);
    expect(screen.queryByText(/技能库/)).toBeNull();
  });

  it('lists installed skills with name, category and description', async () => {
    render(<SkillsModal open port={fakePort()} onClose={() => {}} />);
    expect(await screen.findByText('pptx-to-lesson-plan')).toBeTruthy();
    expect(screen.getByText('trylo-desktop-companion')).toBeTruthy();
    expect(screen.getByText(/read PPT, write lesson plan/)).toBeTruthy();
    expect(screen.getByText('teaching')).toBeTruthy();
    // Count in the title.
    expect(screen.getByText(/技能库 Skills（2）/)).toBeTruthy();
  });

  it('a list failure shows an error with retry, never a fake empty state', async () => {
    const port = fakePort({
      skills: vi.fn(async () => ({ ok: false, error: 'skills adapter timed out' })),
    });
    render(<SkillsModal open port={port} onClose={() => {}} />);
    expect(await screen.findByText(/读不到技能列表/)).toBeTruthy();
    expect(screen.queryByText(/还没有已安装的技能/)).toBeNull();
    // Retry re-calls the port.
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(port.skills).toHaveBeenCalledTimes(2));
  });

  it('a thrown transport error degrades to an error, not empty', async () => {
    const port = fakePort({
      skills: vi.fn(async () => {
        throw new Error('host gone');
      }),
    });
    render(<SkillsModal open port={port} onClose={() => {}} />);
    expect(await screen.findByText(/读不到技能列表.*host gone/)).toBeTruthy();
    expect(screen.queryByText(/还没有已安装的技能/)).toBeNull();
  });

  it('empty installed list renders guidance and a link to pending proposals', async () => {
    const port = fakePort({
      skills: vi.fn(async () => ({ ok: true, skills: [] })),
    });
    const onOpenPending = vi.fn();
    const onClose = vi.fn();
    render(<SkillsModal open port={port} onClose={onClose} onOpenPending={onOpenPending} />);
    expect(await screen.findByText(/还没有已安装的技能/)).toBeTruthy();
    fireEvent.click(screen.getByText('去看待审批提案'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenPending).toHaveBeenCalledTimes(1);
  });

  it('expanding a skill fetches and shows its full content; collapsing hides it', async () => {
    const port = fakePort();
    render(<SkillsModal open port={port} onClose={() => {}} />);
    const row = await screen.findByRole('button', { name: /pptx-to-lesson-plan/ });
    fireEvent.click(row);
    await waitFor(() => expect(port.skills).toHaveBeenCalledWith({ op: 'view', name: 'pptx-to-lesson-plan' }));
    expect(await screen.findByText(/full skill body/)).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByText(/full skill body/)).toBeNull();
  });

  it('a view failure shows an inline error for that skill', async () => {
    const port = fakePort({
      skills: vi.fn(async (params: { op?: string; name?: string }) => {
        if (params.op === 'view') return { ok: false, error: 'not found' };
        return { ok: true, skills: [{ name: 'broken-skill', category: 'x', description: 'd' }] };
      }),
    });
    render(<SkillsModal open port={port} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /broken-skill/ }));
    expect(await screen.findByText(/读不到技能内容.*not found/)).toBeTruthy();
  });

  it('closes on Escape, backdrop click and the close button', async () => {
    const onClose = vi.fn();
    const { container } = render(<SkillsModal open port={fakePort()} onClose={onClose} />);
    await screen.findByText('pptx-to-lesson-plan');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
    const backdrop = container.querySelector('.settings-modal__backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('reloads the list every time it opens', async () => {
    const port = fakePort();
    const { rerender } = render(<SkillsModal open={false} port={port} onClose={() => {}} />);
    expect(port.skills).not.toHaveBeenCalled();
    rerender(<SkillsModal open port={port} onClose={() => {}} />);
    await waitFor(() => expect(port.skills).toHaveBeenCalledTimes(1));
    rerender(<SkillsModal open={false} port={port} onClose={() => {}} />);
    rerender(<SkillsModal open port={port} onClose={() => {}} />);
    await waitFor(() => expect(port.skills).toHaveBeenCalledTimes(2));
  });
});
