// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceManager } from '../services-host/service-manager';
import type { RelayModelConnection } from '../services-host/methods';

type ModelsModule = typeof import('./platform-models');
const hot = { data: {} };
let generation = 0;
async function loadModule(): Promise<ModelsModule> {
  const source = await readFile(new URL('./platform-models.ts', import.meta.url), 'utf8');
  const compiled = await transformWithEsbuild(source, 'platform-models.ts', {
    format: 'esm', define: { 'import.meta.hot': 'globalThis.__platformModelsTestHot' },
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(compiled.code + `\n// generation ${++generation}`).toString('base64');
  return import(/* @vite-ignore */ url);
}
afterEach(() => { vi.unstubAllGlobals(); hot.data = {}; });
const connection: RelayModelConnection = { apiHost: 'http://127.0.0.1:1234/v1', apiKey: 'synthetic-capability', apiModel: 'Qwen3.8-Flash-Next', providerId: 'openai-compatible', apiFormat: 'openai', modelContextWindow: 262144 };

it('a retained Work controller uses the rebound account service after module hot replacement', async () => {
  vi.stubGlobal('__platformModelsTestHot', hot);
  const oldModule = await loadModule();
  const oldManager = new ServiceManager({ invoke: async () => undefined, listen: async () => () => {} });
  const releaseOld = oldModule.bindPlatformModels(oldManager);
  const oldRequest = vi.spyOn(oldManager.client, 'request').mockResolvedValue(connection);
  expect(await oldModule.platformModelConnection(connection.apiModel)).toEqual(connection);
  const newModule = await loadModule();
  const newManager = new ServiceManager({ invoke: async () => undefined, listen: async () => () => {} });
  const newRequest = vi.spyOn(newManager.client, 'request').mockResolvedValue(connection);
  releaseOld();
  const releaseNew = newModule.bindPlatformModels(newManager);
  try {
    expect(await oldModule.platformModelConnection(connection.apiModel)).toEqual(connection);
    expect(newRequest).toHaveBeenCalledTimes(1);
    expect(oldRequest).toHaveBeenCalledTimes(1);
  } finally { releaseNew(); }
});

it('late cleanup of an earlier binding cannot disconnect the newer binding of the same manager', async () => {
  vi.stubGlobal('__platformModelsTestHot', hot);
  const before = await loadModule(), after = await loadModule();
  const manager = new ServiceManager({ invoke: async () => undefined, listen: async () => () => {} });
  vi.spyOn(manager.client, 'request').mockResolvedValue(connection);
  const releaseBefore = before.bindPlatformModels(manager);
  const releaseAfter = after.bindPlatformModels(manager);
  releaseBefore();
  try { expect(await before.platformModelConnection(connection.apiModel)).toEqual(connection); }
  finally { releaseAfter(); }
  await expect(after.platformModelConnection(connection.apiModel)).rejects.toThrow('尚未就绪');
});
