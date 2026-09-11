import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ApprovedRecords } from './ApprovedRecords';
import type { LearningPort } from '../../learning/learning-port';

afterEach(() => cleanup());

function fakePort(over: Record<string, unknown> = {}): LearningPort {
  return {
    memorySnapshot: vi.fn(async () => ({
      ok: true,
      snapshot: {
        memoryBlock: '- 用户是 PCB 教学方向\n- 成品放 .trylo/out/',
        userBlock: '- role: educator',
        memoryCharCount: 30,
        userCharCount: 15,
      },
    })),
    skills: vi.fn(async (params: { op?: string; name?: string }) => {
      if (params.op === 'view') {
        return { ok: true, content: `# ${params.name}\n\nskill body` };
      }
      return {
        ok: true,
        skills: [
          { name: 'pptx-to-lesson-plan', category: 'teaching', description: 'read PPT, write lesson plan' },
        ],
      };
    }),
    ...over,
  } as unknown as LearningPort;
}

describe('ApprovedRecords', () => {
  it('renders committed memory/user blocks and installed skills', async () => {
    render(<ApprovedRecords port={fakePort()} />);
    expect(await screen.findByText(/用户是 PCB 教学方向/)).toBeTruthy();
    expect(screen.getByText(/role: educator/)).toBeTruthy();
    expect(screen.getByText('pptx-to-lesson-plan')).toBeTruthy();
    expect(screen.getByText(/read PPT, write lesson plan/)).toBeTruthy();
  });

  it('a memory snapshot failure is shown as an error, never as "no memory yet"', async () => {
    const port = fakePort({
      memorySnapshot: vi.fn(async () => ({ ok: false, error: 'adapter exited 1' })),
    });
    render(<ApprovedRecords port={port} />);
    expect(await screen.findByText(/读不到记忆快照/)).toBeTruthy();
    expect(screen.queryByText(/还没有已批准的记忆/)).toBeNull();
    // Skills section still renders independently.
    expect(await screen.findByText('pptx-to-lesson-plan')).toBeTruthy();
  });

  it('a skills list failure is shown as an error, never as "no skills yet"', async () => {
    const port = fakePort({
      skills: vi.fn(async () => ({ ok: false, error: 'skills adapter timed out' })),
    });
    render(<ApprovedRecords port={port} />);
    expect(await screen.findByText(/读不到技能列表/)).toBeTruthy();
    expect(screen.queryByText(/还没有已批准的技能/)).toBeNull();
  });

  it('empty committed state renders empty guidance', async () => {
    const port = fakePort({
      memorySnapshot: vi.fn(async () => ({ ok: true, snapshot: { memoryBlock: '   ', userBlock: '' } })),
      skills: vi.fn(async () => ({ ok: true, skills: [] })),
    });
    render(<ApprovedRecords port={port} />);
    expect(await screen.findByText(/还没有已批准的记忆条目/)).toBeTruthy();
    expect(screen.getByText(/还没有已批准的技能/)).toBeTruthy();
  });

  it('expanding a skill fetches and shows its committed content', async () => {
    const port = fakePort();
    render(<ApprovedRecords port={port} />);
    const row = await screen.findByRole('button', { name: /pptx-to-lesson-plan/ });
    fireEvent.click(row);
    await waitFor(() => expect(port.skills).toHaveBeenCalledWith({ op: 'view', name: 'pptx-to-lesson-plan' }));
    expect(await screen.findByText(/skill body/)).toBeTruthy();
  });

  it('reloads when reloadKey changes (e.g. right after an approval)', async () => {
    const port = fakePort();
    const { rerender } = render(<ApprovedRecords port={port} reloadKey={0} />);
    await screen.findByText('pptx-to-lesson-plan');
    expect(port.memorySnapshot).toHaveBeenCalledTimes(1);
    rerender(<ApprovedRecords port={port} reloadKey={1} />);
    await waitFor(() => expect(port.memorySnapshot).toHaveBeenCalledTimes(2));
  });
});
