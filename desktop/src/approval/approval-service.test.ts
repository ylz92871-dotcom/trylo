// Trylo Desktop — ApprovalService tests (spec §6.4): requestId routing to
// the owning authority, never by "current selection".

import { describe, expect, it, vi } from 'vitest';

import { ApprovalService } from './approval-service';

describe('ApprovalService', () => {
  it('routes to the Work authority when the id is pending there', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const service = new ApprovalService({
      work: { isPending: (id) => id === 'ap-1', respond },
      code: { isPending: () => false, respond: vi.fn().mockResolvedValue(true) },
    });
    await expect(service.decide('ap-1', 'allow')).resolves.toBe(true);
    expect(respond).toHaveBeenCalledWith('ap-1', true);
  });

  it('routes to the Code authority when only the registry holds the id', async () => {
    const respond = vi.fn().mockResolvedValue(true);
    const service = new ApprovalService({
      work: { isPending: () => false, respond: vi.fn().mockResolvedValue(undefined) },
      code: { isPending: (id) => id === 'req-9', respond },
    });
    await expect(service.decide('req-9', 'deny')).resolves.toBe(true);
    expect(respond).toHaveBeenCalledWith('req-9', false);
  });

  it('reports unrouted ids and resolves false without guessing', async () => {
    const unrouted = vi.fn();
    const workRespond = vi.fn();
    const codeRespond = vi.fn();
    const service = new ApprovalService({
      work: { isPending: () => false, respond: workRespond },
      code: { isPending: () => false, respond: codeRespond },
      onUnrouted: unrouted,
    });
    await expect(service.decide('ghost', 'allow')).resolves.toBe(false);
    expect(workRespond).not.toHaveBeenCalled();
    expect(codeRespond).not.toHaveBeenCalled();
    expect(unrouted).toHaveBeenCalledWith({ requestId: 'ghost', decision: 'allow' });
  });

  it('works with no authorities wired (all decisions unrouted)', async () => {
    const service = new ApprovalService();
    await expect(service.decide('x', 'deny')).resolves.toBe(false);
  });
});
