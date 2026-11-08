import { useEffect, useMemo, useState } from 'react';
import type { ServiceManager } from '../services-host/service-manager';
import { AgentModelPreviewBridge, type AgentModelSession } from './agent-model-preview-bridge';

/** The bridge remains mounted across chat navigation; navigation never retargets a reply. */
export function useAgentModelPreview(manager: ServiceManager): {
  readonly bridge: AgentModelPreviewBridge;
  readonly sessions: readonly AgentModelSession[];
  readonly close: (scope: string) => void;
} {
  const bridge = useMemo(() => new AgentModelPreviewBridge(), [manager]);
  const [sessions, setSessions] = useState<readonly AgentModelSession[]>([]);
  useEffect(() => {
    const unsubscribe = bridge.subscribe(() => setSessions(bridge.sessions()));
    const client = manager.client;
    let bridgeId: string | undefined;
    let epoch = 0;
    let disposed = false;
    const attach = async (): Promise<void> => {
      const generation = ++epoch;
      const attached = await client.request('tooling.modelPreviewAttach', {});
      if (disposed || generation !== epoch) {
        await client.request('tooling.modelPreviewDetach', { bridgeId: attached.bridgeId }).catch(() => {});
      } else bridgeId = attached.bridgeId;
    };
    const offCommand = client.onEvent('tooling.modelPreviewCommand', command => {
      if (!bridgeId || command.bridgeId !== bridgeId) return;
      void bridge.execute(command).then(
        result => client.request('tooling.modelPreviewCommandResult', { id: command.id, bridgeId: command.bridgeId, result }),
        error => client.request('tooling.modelPreviewCommandResult', { id: command.id, bridgeId: command.bridgeId,
          error: error instanceof Error ? error.message : String(error) }),
      ).catch(() => {});
    });
    const offChanged = client.onEvent('tooling.modelPreviewChanged', event => {
      if (bridgeId && event.bridgeId === bridgeId) bridge.changed(event);
    });
    const offCancelled = client.onEvent('tooling.modelPreviewCancelled', event => {
      if (bridgeId && event.bridgeId === bridgeId) bridge.cancel(event.id);
    });
    const offHealth = manager.onHealth(health => {
      if (health === 'ready') void attach().catch(() => {});
      else { bridgeId = undefined; epoch++; bridge.cancelAll(); }
    });
    if (manager.currentHealth === 'ready') void attach().catch(() => {});
    return () => {
      disposed = true; epoch++;
      bridge.cancelAll();
      offCommand(); offChanged(); offCancelled(); offHealth(); unsubscribe();
      if (bridgeId) void client.request('tooling.modelPreviewDetach', { bridgeId }).catch(() => {});
      // StrictMode replays this setup. A fresh setup owns a fresh generation,
      // while individual scene cleanups reject their own pending reads.
      for (const session of bridge.sessions()) bridge.close(session.scope);
    };
  }, [bridge, manager]);
  return { bridge, sessions, close: scope => {
    bridge.close(scope);
    void manager.client.request('tooling.modelPreviewClose', { scope }).catch(() => {});
  } };
}
