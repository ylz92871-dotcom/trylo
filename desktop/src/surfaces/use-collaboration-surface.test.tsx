import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useCollaborationSurface, type CollaborationViewScope, type CollaborationViewStorage } from './use-collaboration-surface';

afterEach(cleanup);
const scope = (patch: Partial<CollaborationViewScope> = {}): CollaborationViewScope => ({
  workspaceKey: 'd:/test', mode: 'code', conversationId: 'team-chat', ...patch,
});
function storage(): CollaborationViewStorage {
  let raw: string | null = null;
  return { load: () => raw, save: value => { raw = value; } };
}

it('opens existing team history automatically, including history arriving after initial render', () => {
  const port = storage();
  const { result, rerender } = renderHook(({ history }) => useCollaborationSurface(scope(), history, port),
    { initialProps: { history: false } });
  expect(result.current[0]).toBe('person');
  rerender({ history: true });
  expect(result.current[0]).toBe('team');
  expect(port.load()).toBeNull();
});

it('keeps explicit person preference over team history after remount', () => {
  const port = storage();
  const first = renderHook(() => useCollaborationSurface(scope(), true, port));
  act(() => first.result.current[1]('person')); first.unmount();
  const second = renderHook(() => useCollaborationSurface(scope(), true, port));
  expect(second.result.current[0]).toBe('person');
  expect(port.load()).not.toBeNull();
});

it('keeps the team composer choice without task history across remount', () => {
  const port = storage();
  const first = renderHook(() => useCollaborationSurface(scope(), false, port));
  act(() => first.result.current[1]('team')); first.unmount();
  const second = renderHook(() => useCollaborationSurface(scope(), false, port));
  expect(second.result.current[0]).toBe('team');
});

it.each(['workspaceKey', 'mode', 'conversationId'] as const)('isolates %s and restores the first choice on return', field => {
  const port = storage();
  const original = scope();
  const other = scope(field === 'workspaceKey' ? { workspaceKey: 'd:/other' }
    : field === 'mode' ? { mode: 'work' } : { conversationId: 'other-chat' });
  const { result, rerender } = renderHook(({ current }) => useCollaborationSurface(current, false, port),
    { initialProps: { current: original } });
  act(() => result.current[1]('team'));
  rerender({ current: other });
  expect(result.current[0]).toBe('person');
  rerender({ current: original });
  expect(result.current[0]).toBe('team');
});

it('a captured old-session callback cannot change the newly selected session', () => {
  const port = storage();
  const { result, rerender } = renderHook(({ current }) => useCollaborationSurface(current, false, port),
    { initialProps: { current: scope() } });
  const oldSelect = result.current[1];
  rerender({ current: scope({ conversationId: 'new-chat' }) });
  act(() => oldSelect('team'));
  expect(result.current[0]).toBe('person');
  rerender({ current: scope() });
  expect(result.current[0]).toBe('team');
});

it.each(['{broken', '{"schemaVersion":99,"choices":[]}'])('ignores malformed or unknown-version preferences: %s', raw => {
  const port = { load: () => raw, save() {} };
  const { result } = renderHook(() => useCollaborationSurface(scope(), true, port));
  expect(result.current[0]).toBe('team');
});

it('storage refusal retains an explicit in-memory selection', () => {
  const port = { load(): never { throw new Error('storage denied'); }, save(): never { throw new Error('quota'); } };
  const { result, rerender } = renderHook(({ history }) => useCollaborationSurface(scope(), history, port),
    { initialProps: { history: true } });
  expect(result.current[0]).toBe('team');
  act(() => result.current[1]('person')); rerender({ history: false }); rerender({ history: true });
  expect(result.current[0]).toBe('person');
});
