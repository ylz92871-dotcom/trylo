import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PendingProposals } from './PendingProposals';
import type { LearningPort } from '../../learning/learning-port';

afterEach(() => cleanup());

const HASH = 'sha256:' + 'a'.repeat(64);

function fakePort(over: Record<string, unknown> = {}): LearningPort {
  // Mutable queue: apply/discard really remove the item, so the post-action
  // re-fetch verifies the backend state the same way production does.
  const queue: Record<string, unknown>[] = [
    { id: 'p1', subsystem: 'skills', action: 'create', summary: "create 'demo-skill' — a skill", origin: 'foreground', created_at: 1787994502 },
    { id: 'm1', subsystem: 'memory', action: 'add', summary: 'remember a fact', origin: 'foreground', created_at: 1787994600 },
  ];
  return {
    listPending: vi.fn(async () => ({
      ok: true,
      pending: queue.map((q) => ({ ...q })),
      count: queue.length,
    })),
    pendingDetail: vi.fn(async () => ({
      ok: true,
      detail: { item: { id: 'p1', content: 'skill body text', expectedHash: HASH } },
    })),
    applyPending: vi.fn(async (params: { id: string }) => {
      const i = queue.findIndex((q) => q.id === params.id);
      if (i >= 0) queue.splice(i, 1);
      return { ok: true, result: { applied: 1 } };
    }),
    discardPending: vi.fn(async (params: { id: string }) => {
      const i = queue.findIndex((q) => q.id === params.id);
      if (i >= 0) queue.splice(i, 1);
      return { ok: true, result: { discarded: 1 } };
    }),
    ...over,
  } as unknown as LearningPort;
}

describe('PendingProposals', () => {
  it('renders the staged queue with subsystem badges and summaries', async () => {
    render(<PendingProposals port={fakePort()} />);
    expect(await screen.findByText("create 'demo-skill' — a skill")).toBeTruthy();
    expect(screen.getByText('remember a fact')).toBeTruthy();
    expect(screen.getAllByText('技能').length).toBeGreaterThan(0);
    expect(screen.getAllByText('记忆').length).toBeGreaterThan(0);
  });

  it('reports the queue count via onCountChange', async () => {
    const onCountChange = vi.fn();
    render(<PendingProposals port={fakePort()} onCountChange={onCountChange} />);
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(2));
  });

  it('an infrastructure failure is shown as an error, never as an empty queue', async () => {
    const port = fakePort({
      listPending: vi.fn(async () => ({ ok: false, pending: [], count: 0, error: 'admin.py exited 1' })),
    });
    render(<PendingProposals port={port} />);
    expect(await screen.findByText(/读不到待审批队列/)).toBeTruthy();
    expect(screen.queryByText(/没有等待审批/)).toBeNull();
  });

  it('an empty queue renders the empty state', async () => {
    const port = fakePort({
      listPending: vi.fn(async () => ({ ok: true, pending: [], count: 0 })),
    });
    render(<PendingProposals port={port} />);
    expect(await screen.findByText(/没有等待审批/)).toBeTruthy();
  });

  it('approve sends the reviewed expectedHash, then the item disappears and a success notice is shown', async () => {
    const port = fakePort();
    const onSettled = vi.fn();
    render(<PendingProposals port={port} onSettled={onSettled} />);
    const row = await screen.findByRole('button', { name: /新建/ });
    fireEvent.click(row);
    const approve = await screen.findByRole('button', { name: '批准写入' });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(port.applyPending).toHaveBeenCalledTimes(1));
    expect(port.applyPending).toHaveBeenCalledWith({
      subsystem: 'skills',
      id: 'p1',
      expectedHash: HASH,
      reason: 'approved in Trylo desktop',
    });
    // Verified against the post-action re-fetch: the row is gone and the
    // user gets explicit confirmation that the write reached the backend.
    await waitFor(() => expect(screen.queryByRole('button', { name: /新建/ })).toBeNull());
    expect(await screen.findByText(/已批准并写入后端/)).toBeTruthy();
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it('if the backend still returns the item after a successful apply, a warning is shown instead of success', async () => {
    const port = fakePort({
      applyPending: vi.fn(async () => ({ ok: true, result: { applied: 1 } })),
    });
    render(<PendingProposals port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建/ }));
    fireEvent.click(await screen.findByRole('button', { name: '批准写入' }));
    expect(await screen.findByText(/写入可能未真正生效/)).toBeTruthy();
    expect(screen.queryByText(/已批准并写入后端/)).toBeNull();
  });

  it('a failed apply keeps the item and shows an error notice', async () => {
    const port = fakePort({
      applyPending: vi.fn(async () => ({ ok: false, error: 'hash mismatch' })),
    });
    render(<PendingProposals port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建/ }));
    fireEvent.click(await screen.findByRole('button', { name: '批准写入' }));
    expect(await screen.findByText(/批准失败/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /新建/ })).toBeTruthy();
  });

  it('approve is blocked when no hash can be extracted from the detail', async () => {
    const port = fakePort({
      pendingDetail: vi.fn(async () => ({ ok: true, detail: { item: { id: 'p1', content: 'no hash here' } } })),
    });
    render(<PendingProposals port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建/ }));
    const approve = await screen.findByRole('button', { name: '批准写入' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(approve);
    expect(port.applyPending).not.toHaveBeenCalled();
  });

  it('discard asks for confirmation once, then discards the staged proposal', async () => {
    const port = fakePort();
    render(<PendingProposals port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: /新增/ }));
    const discard = await screen.findByRole('button', { name: '拒绝' });
    fireEvent.click(discard);
    expect(port.discardPending).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('button', { name: '再点一次确认拒绝' });
    fireEvent.click(confirm);
    await waitFor(() => expect(port.discardPending).toHaveBeenCalledTimes(1));
    expect(port.discardPending).toHaveBeenCalledWith({ subsystem: 'memory', id: 'm1' });
    // Discard is verified the same way: the row leaves the queue and the
    // user gets an explicit confirmation.
    await waitFor(() => expect(screen.queryByRole('button', { name: /新增/ })).toBeNull());
    expect(await screen.findByText(/已拒绝并从队列移除/)).toBeTruthy();
  });
});
