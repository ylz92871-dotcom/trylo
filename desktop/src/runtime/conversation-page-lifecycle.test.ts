import { expect, it, vi } from 'vitest';
import { bindConversationPageLifecycle } from './conversation-page-lifecycle';

it('a native page reload leaves process shutdown to its native owner', () => {
  const page = new EventTarget(); const stopAll = vi.fn(async () => {});
  const detach = bindConversationPageLifecycle({ host: 'native', page, stopAll, onStopError: vi.fn() });
  try { page.dispatchEvent(new Event('pagehide')); expect(stopAll).not.toHaveBeenCalled(); }
  finally { detach(); }
});

it('browser page hide still requests cleanup of its owned conversations', async () => {
  const page = new EventTarget(); const stopAll = vi.fn(async () => {});
  const detach = bindConversationPageLifecycle({ host: 'browser', page, stopAll, onStopError: vi.fn() });
  try { page.dispatchEvent(new Event('pagehide')); await Promise.resolve(); expect(stopAll).toHaveBeenCalledOnce(); }
  finally { detach(); }
});

it('unsubscribing prevents later page events from stopping roots', () => {
  const page = new EventTarget(); const stopAll = vi.fn(async () => {});
  const detach = bindConversationPageLifecycle({ host: 'browser', page, stopAll, onStopError: vi.fn() });
  detach(); page.dispatchEvent(new Event('pagehide')); expect(stopAll).not.toHaveBeenCalled();
});

it('reports a rejected browser cleanup instead of losing its refusal', async () => {
  const page = new EventTarget(); const failure = new Error('browser cleanup refused'); const onStopError = vi.fn();
  const detach = bindConversationPageLifecycle({ host: 'browser', page, stopAll: async () => { throw failure; }, onStopError });
  try { page.dispatchEvent(new Event('pagehide')); await Promise.resolve(); expect(onStopError).toHaveBeenCalledWith(failure); }
  finally { detach(); }
});

it('reports a synchronous cleanup fault through the same failure boundary', () => {
  const page = new EventTarget(); const failure = new Error('browser cleanup fault'); const onStopError = vi.fn();
  const detach = bindConversationPageLifecycle({ host: 'browser', page, stopAll: () => { throw failure; }, onStopError });
  try { page.dispatchEvent(new Event('pagehide')); expect(onStopError).toHaveBeenCalledWith(failure); }
  finally { detach(); }
});

it('observes a late browser cleanup refusal after its listener is removed', async () => {
  const page = new EventTarget(); const onStopError = vi.fn(); let refuse!: (error: Error) => void;
  const receipt = new Promise<void>((_resolve, reject) => { refuse = reject; });
  const detach = bindConversationPageLifecycle({ host: 'browser', page, stopAll: () => receipt, onStopError });
  page.dispatchEvent(new Event('pagehide')); detach();
  const failure = new Error('late browser cleanup refusal'); refuse(failure); await Promise.resolve();
  expect(onStopError).toHaveBeenCalledWith(failure);
});
