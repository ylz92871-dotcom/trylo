// Tooling facade: keep the renderer protocol in lock-step with the Service Host.

import { describe, expect, it, vi } from 'vitest';

import { ServiceRequestError } from '../services-host/services-client';
import { createToolingFacade } from './tooling-facade';

function fakeClient() {
  const calls: { method: string; params?: unknown }[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === 'tooling.localOverrides') {
      return { ok: true, overrides: {}, repository: { path: null, entries: {} } };
    }
    return { ok: true, id: 'playwright', path: null, overrides: {} };
  });
  return { calls, client: { request } as never };
}

describe('createToolingFacade local tool bindings', () => {
  const profileRequest = { surface: 'work' as const, projectKey: 'p', projectRoot: 'D:/p', conversationId: 'c', permissionLevel: 'ask' as const };

  it('does not silently start a required Work profile after a directory write failure', async () => {
    const client = { request: vi.fn(async () => ({ ok: false, reasonCode: 'config_write_failed', error: 'EPERM private path' })) } as never;
    const facade = createToolingFacade(client);
    await expect(facade.resolveProfile(profileRequest, { required: true })).rejects.toMatchObject({
      code: 'config_write_failed', message: expect.stringContaining('写入权限'),
    });
    await expect(facade.resolveProfile(profileRequest)).resolves.toBeNull();
  });

  it('reports transport failure for a required profile and grants cold probes their full budget', async () => {
    const request = vi.fn(async () => { throw new ServiceRequestError('TIMEOUT', 'raw transport internals'); });
    const facade = createToolingFacade({ request } as never);
    await expect(facade.resolveProfile(profileRequest, { required: true })).rejects.toMatchObject({ code: 'TIMEOUT', message: '工具加载超时，请稍后重试。' });
    expect(request).toHaveBeenCalledWith('tooling.resolveProfile', expect.objectContaining({ surface: 'work' }), { timeoutMs: 120_000 });
  });

  it('forwards set, clear, and inspect to the registered RPC names', async () => {
    const { calls, client } = fakeClient();
    const facade = createToolingFacade(client);

    await facade.setLocalOverride('playwright', 'D:/tools/playwright/cli.js');
    await facade.clearLocalOverride('playwright');
    await facade.localOverrides();

    expect(calls).toEqual([
      {
        method: 'tooling.setLocalOverride',
        params: { id: 'playwright', path: 'D:/tools/playwright/cli.js' },
      },
      { method: 'tooling.clearLocalOverride', params: { id: 'playwright' } },
      { method: 'tooling.localOverrides', params: undefined },
    ]);
  });

  it('degrades an override inspection to null when the Service Host is down', async () => {
    const client = {
      request: vi.fn(async () => {
        throw new ServiceRequestError('NOT_CONNECTED', 'host gone');
      }),
    } as never;

    await expect(createToolingFacade(client).localOverrides()).resolves.toBeNull();
  });
});
