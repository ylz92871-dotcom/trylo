import { hostAdapter } from '../host-adapter';
import { registeredProcessIds } from '../host-adapter/process-snapshot';
import type { CodePermissionRequest } from './code-permission-registry';

interface PermissionOwnerSource {
  pendingCodePermissions(): readonly CodePermissionRequest[];
  libraryApprovalPort(scope: { projectKey: string; conversationId: string }): { clearProcess(processId: string): void };
  getViewState?(projectKey: string, conversationId: string): { running: boolean; activeProcessId: string | null };
}
export interface ApprovalSubscriptionSource {
  pendingCodePermissions(): readonly CodePermissionRequest[];
  subscribe(listener: () => void): () => void;
  libraryApprovalPort?: PermissionOwnerSource['libraryApprovalPort'];
  getViewState?: PermissionOwnerSource['getViewState'];
}
type ReadProcesses = () => Promise<unknown>;
const readNativeProcesses: ReadProcesses = () => hostAdapter.process.list();

/** An old pending entry is not proof that its native owner still exists.
 *  Only a valid native snapshot may expire it; failed reads preserve it. */
export async function reconcileCodePermissionOwners(source: PermissionOwnerSource,
  readProcesses: ReadProcesses = readNativeProcesses): Promise<void> {
  const snapshot = source.pendingCodePermissions();
  if (!snapshot.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const processes = await Promise.race([Promise.resolve().then(readProcesses), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Approval owner lookup timed out')), 1500);
    })]);
    const live = registeredProcessIds(processes);
    for (const request of snapshot) {
      const view = source.getViewState?.(request.projectKey, request.conversationId);
      const ended = view?.activeProcessId === request.processId && view.running === false;
      if (live.has(request.processId) && !ended) continue;
      // Do not consume requests from another, newly started process while the
      // snapshot was being read. Native handles and request ids are immutable.
      if (!source.pendingCodePermissions().some(current => current.requestId === request.requestId
        && current.processId === request.processId)) continue;
      source.libraryApprovalPort({ projectKey: request.projectKey, conversationId: request.conversationId })
        .clearProcess(request.processId);
    }
  } finally { clearTimeout(timer); }
}

const subscriptions = new WeakMap<ApprovalSubscriptionSource, ApprovalSubscriptionSource['subscribe']>();

/** Reconcile on subscription and on changes to pending ownership. This also
 *  repairs an already open renderer without replacing its live supervisor. */
export function reconciledApprovalSubscription(source: ApprovalSubscriptionSource,
  readProcesses: ReadProcesses = readNativeProcesses): ApprovalSubscriptionSource['subscribe'] {
  const cached = subscriptions.get(source);
  if (cached) return cached;
  const port = source.libraryApprovalPort;
  if (!port) return source.subscribe;
  const owner: PermissionOwnerSource = { pendingCodePermissions: () => source.pendingCodePermissions(),
    libraryApprovalPort: scope => port.call(source, scope),
    ...(source.getViewState ? { getViewState: (projectKey: string, conversationId: string) => source.getViewState!(projectKey, conversationId) } : {}) };
  let checked: string | null = null;
  const refresh = (): void => {
    const pending = source.pendingCodePermissions();
    const key = JSON.stringify(pending.map(request => [request.requestId, request.processId,
      source.getViewState?.(request.projectKey, request.conversationId).running]));
    if (checked === key) return;
    checked = key;
    void reconcileCodePermissionOwners(owner, readProcesses).catch(() => { if (checked === key) checked = null; });
  };
  const subscribe: ApprovalSubscriptionSource['subscribe'] = listener => {
    const dispose = source.subscribe(() => { listener(); refresh(); });
    refresh();
    return dispose;
  };
  subscriptions.set(source, subscribe);
  return subscribe;
}
