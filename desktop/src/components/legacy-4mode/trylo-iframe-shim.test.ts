// Trylo Desktop — iframe shim unit tests. See ARCHITECTURE.md §3
// Phase 2 task #1.
//
// The shim is the only piece of glue that lets the legacy
// `acquireVsCodeApi()`-based code talk to the new `acquireTryloApi()`
// surface. We test:
//   - the legacy `vscode.postMessage` shape returns void and forwards
//     to the api
//   - the legacy `getState` / `setState` round-trip
//   - that rejections are logged but do not throw

import { describe, expect, it, vi } from 'vitest';
import type { TryloApi, TryloRequest, TryloResponse } from '../../host-adapter/trylo-api';

function makeApi() {
  const postMessage = vi.fn(
    async (_msg: TryloRequest): Promise<TryloResponse> => {
      return {
        type: 'init',
        ok: true,
        sessionId: 'x',
        mode: 'chat',
        workspaceRoot: '',
      };
    },
  );
  const getState = vi.fn(() => undefined);
  const setState = vi.fn();
  const api: TryloApi = {
    postMessage: postMessage as unknown as TryloApi['postMessage'],
    onMessage: () => () => undefined,
    getState: getState as unknown as TryloApi['getState'],
    setState: setState as unknown as TryloApi['setState'],
  };
  return { api, postMessage, getState, setState };
}

describe('trylo-iframe-shim', () => {
  it('legacy postMessage is fire-and-forget and forwards to api', async () => {
    const { api, postMessage } = makeApi();
    const { makeVsCodeShim } = await import('./trylo-iframe-shim');
    const shim = makeVsCodeShim(api);
    shim.postMessage({ type: 'init' });
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ type: 'init' });
  });

  it('legacy postMessage swallows rejections (logs but does not throw)', async () => {
    const postMessage = vi.fn(async () => {
      throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { makeVsCodeShim } = await import('./trylo-iframe-shim');
    const shim = makeVsCodeShim({
      postMessage: postMessage as unknown as TryloApi['postMessage'],
      onMessage: () => () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    });
    expect(() => shim.postMessage({ type: 'init' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('legacy getState / setState delegate to the api', async () => {
    const { api, getState, setState } = makeApi();
    const { makeVsCodeShim } = await import('./trylo-iframe-shim');
    const shim = makeVsCodeShim(api);
    void shim.getState();
    shim.setState({ hello: 'world' });
    expect(getState).toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith({ hello: 'world' });
  });
});
