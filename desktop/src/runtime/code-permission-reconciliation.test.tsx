import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CodePermissionRegistry } from './code-permission-registry';
import { reconcileCodePermissionOwners, reconciledApprovalSubscription } from './code-permission-reconciliation';
import { useCodeApprovals } from '../components/chat/code-approval-messages';
import { ApprovalCard } from '../components/chat/ApprovalCard';

vi.mock('../host-adapter', () => ({ hostAdapter: { process: { list: vi.fn(async () => [{ id: 'new-process' }]) } } }));
afterEach(cleanup);

function fixture() {
  let version = 0;
  const listeners = new Set<() => void>();
  const send = vi.fn(async () => true);
  const registry = new CodePermissionRegistry({ send, onChange() { version++; for (const listener of listeners) listener(); } });
  // Deliberately only the pre-existing supervisor API: an already open
  // renderer must not need a replacement supervisor to repair its old card.
  const source = { pendingCodePermissions: () => registry.list(), getVersion: () => version,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    libraryApprovalPort() { return { clearProcess: (id: string) => registry.clearProcess(id) }; } };
  const register = (id: string, processId: string) => registry.handleControlFrame({ kind: 'permission', requestId: id,
    toolName: 'run_shell', input: { command: 'Get-ChildItem' } }, { processId, projectKey: 'p', conversationId: 'c' });
  return { source, registry, register, send };
}

it('automatically removes the dead old card from an open view while the new approval still works', async () => {
  const h = fixture();
  h.register('old', 'dead-process'); h.register('new', 'new-process');
  function View() {
    const messages = useCodeApprovals(h.source, 'p', 'c');
    return <>{messages.map(message => message.kind === 'approval' ? <ApprovalCard key={message.id} message={message}
      onRespond={(id, allow) => h.registry.respond(id, allow)} /> : null)}</>;
  }
  render(<View />);
  await waitFor(() => expect(h.registry.list().map(request => request.requestId)).toEqual(['new']));
  expect(screen.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1);
  expect(await h.registry.respond('old', true)).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
  await act(async () => { await h.registry.respond('new', true); });
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull();
});

it.each([undefined, null, {}, [{ pid: 1 }]])('does not expire an approval from an invalid native snapshot %j', async snapshot => {
  const h = fixture(); h.register('pending', 'new-process');
  await expect(reconcileCodePermissionOwners(h.source, async () => snapshot)).rejects.toThrow();
  expect(h.registry.list()).toHaveLength(1);
});

it('expires a completed turn even if its idle CLI is still alive, preserving unowned library approvals', async () => {
  const h = fixture(); h.register('ended', 'idle-cli'); h.register('library', 'library-cli');
  const source = { ...h.source, getViewState: () => ({ running: false, activeProcessId: 'idle-cli' }) };
  await reconcileCodePermissionOwners(source, async () => [{ id: 'idle-cli' }, { id: 'library-cli' }]);
  expect(h.registry.list().map(request => request.requestId)).toEqual(['library']);
});

it('does not consume a new request created while the older snapshot is being read', async () => {
  const h = fixture(); h.register('old', 'dead-process');
  let finish!: (value: unknown) => void;
  const reconciliation = reconcileCodePermissionOwners(h.source, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  h.register('new', 'new-process');
  finish([]);
  await reconciliation;
  expect(h.registry.list().map(request => request.requestId)).toEqual(['new']);
});

it('checks the pending-owner set once instead of querying on every text-stream update', async () => {
  const h = fixture(); h.register('pending', 'new-process');
  const read = vi.fn(async () => [{ id: 'new-process' }]);
  const subscribe = reconciledApprovalSubscription(h.source, read);
  const unmount = subscribe(() => {});
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  const otherUnmount = subscribe(() => {});
  expect(read).toHaveBeenCalledOnce();
  unmount(); otherUnmount();
});
