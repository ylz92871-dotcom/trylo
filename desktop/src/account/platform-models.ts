import type { ServiceManager } from '../services-host/service-manager';
import type { RelayModelCatalog, RelayModelConnection } from '../services-host/methods';

interface PlatformModelsState {
  manager: ServiceManager | null;
  binding: symbol | null;
  catalogRequest?: Promise<RelayModelCatalog>;
  listeners: Set<() => void>;
}
// Controllers survive React Fast Refresh and can retain the previous module's
// functions. Both generations must read the same binding, not separate globals.
// Vite's hot data lives only in this renderer; no credentials are persisted.
const hotData = import.meta.hot?.data;
const state: PlatformModelsState = hotData?.platformModelsState ?? {
  manager: null, binding: null, listeners: new Set<() => void>(),
};
if (hotData) hotData.platformModelsState = state;
const changed = () => { state.catalogRequest = undefined; for (const listener of state.listeners) listener(); };

/** App composition boundary. Never stores an account token or provider key. */
export function bindPlatformModels(value: ServiceManager): () => void {
  const binding = Symbol('platform-model-binding');
  state.manager = value;
  state.binding = binding;
  const offAccount = value.client.onEvent('account.changed', changed);
  const offHealth = value.onHealth(changed);
  changed();
  return () => {
    offAccount(); offHealth();
    if (state.binding === binding) { state.manager = null; state.binding = null; changed(); }
  };
}
export function subscribePlatformModels(listener: () => void): () => void {
  state.listeners.add(listener); return () => { state.listeners.delete(listener); };
}
export async function readPlatformModels(): Promise<RelayModelCatalog> {
  if (!state.manager) throw Error('请先登录 Trylo 账号以同步免费模型。');
  // Work composer, context preview and settings share one concurrent read.
  // Do not cache an answer: subsequent refreshes must see changed grants/caps.
  if (state.catalogRequest) return state.catalogRequest;
  const owner = state.manager;
  const binding = state.binding;
  const request = owner.client.request('remote.relayModels').then(value => {
    if (state.binding !== binding) throw Error('账号服务已变化，请重新同步模型。');
    return value;
  });
  state.catalogRequest = request;
  try { return await request; }
  finally { if (state.catalogRequest === request) state.catalogRequest = undefined; }
}
export async function platformModelConnection(model: string): Promise<RelayModelConnection> {
  if (!state.manager) throw Error('Trylo 账号服务尚未就绪，请稍后重试。');
  const owner = state.manager;
  const binding = state.binding;
  const connection = await owner.client.request('remote.relayModelConnection', { model });
  if (state.binding !== binding) throw Error('账号服务已变化，请重新发送。');
  // An already-running host from before context support can still issue a
  // valid model capability. Read its authorized catalog instead of guessing
  // 200K for that model or requiring a window restart just for metadata.
  if (Number.isSafeInteger(connection.modelContextWindow) && connection.modelContextWindow! > 0) return connection;
  const catalog = await readPlatformModels();
  if (state.binding !== binding) throw Error('账号服务已变化，请重新发送。');
  const capacity = catalog.models.find(item => item.id === model && item.chat && item.pool === 'free')?.contextLength;
  return Number.isSafeInteger(capacity) && capacity! > 0 ? { ...connection, modelContextWindow: capacity } : connection;
}
