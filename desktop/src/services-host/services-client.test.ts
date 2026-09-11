// Trylo Desktop — ServicesClient tests: request/response correlation,
// timeouts, typed event subscription, malformed-line tolerance.
// The Tauri boundary is faked in-memory (spec §10 L3).

import { describe, expect, it, vi } from 'vitest';

import { encodeFrame } from './frames';
import { ServicesClient } from './services-client';

interface Harness {
  client: ServicesClient;
  /** Simulates the Rust shell emitting one raw stdout line. */
  emit(line: string): void;
  /** The frames the renderer pushed toward the sidecar. */
  sent: string[];
  /** Resolve/reject hooks for pending servicehost_send invokes. */
  settleNextSend(): void;
}

function createHarness(): Harness {
  const sent: string[] = [];
  let frameHandler: ((event: { payload: unknown }) => void) | null = null;
  const harness: Harness = {
    sent,
    settleNextSend: () => {},
    client: null as unknown as ServicesClient,
    emit(line: string) {
      frameHandler?.({ payload: line });
    },
  };
  const invoke = vi.fn((_cmd: string, args?: Record<string, unknown>) => {
    sent.push(String(args?.['frame'] ?? ''));
    return Promise.resolve();
  });
  const listen = vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
    frameHandler = handler;
    return Promise.resolve(() => {
      frameHandler = null;
    });
  });
  harness.client = new ServicesClient({ invoke, listen });
  return harness;
}

describe('ServicesClient', () => {
  it('correlates a response frame to its pending request', async () => {
    const h = createHarness();
    await h.client.start();
    const pending = h.client.request('pet.enable', { workspacePath: '/w' });
    expect(h.sent.length).toBe(1);
    const requestFrame = JSON.parse(h.sent[0]!);
    expect(requestFrame.method).toBe('pet.enable');
    h.emit(
      encodeFrame({ version: 1, type: 'response', id: requestFrame.id, ok: true, result: { ok: true, enabled: true, exeFound: true } }),
    );
    await expect(pending).resolves.toMatchObject({ enabled: true });
  });

  it('rejects with the error frame code + message', async () => {
    const h = createHarness();
    await h.client.start();
    const pending = h.client.request('pet.openChat');
    const requestFrame = JSON.parse(h.sent[0]!);
    h.emit(
      encodeFrame({ version: 1, type: 'response', id: requestFrame.id, ok: false, error: { code: 'NOT_CONNECTED', message: 'gone' } }),
    );
    await expect(pending).rejects.toMatchObject({ code: 'NOT_CONNECTED', message: 'gone' });
  });

  it('rejects NOT_CONNECTED when the shell cannot send', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('NotConnected')));
    const listen = vi.fn(() => Promise.resolve(() => {}));
    const client = new ServicesClient({ invoke, listen });
    await client.start();
    await expect(client.request('pet.disable')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('dispatches events to typed subscribers', async () => {
    const h = createHarness();
    await h.client.start();
    const seen: unknown[] = [];
    h.client.onEvent('pet.status', (payload) => seen.push(payload));
    h.emit(encodeFrame({ version: 1, type: 'event', topic: 'pet.status', payload: { enabled: true, exeFound: false, chatConnected: false } }));
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ enabled: true });
  });

  it('ignores malformed lines without disturbing pending requests', async () => {
    const h = createHarness();
    await h.client.start();
    const pending = h.client.request('pet.disable');
    h.emit('not json at all');
    h.emit(encodeFrame({ version: 1, type: 'event', topic: 'petChatEmit' }).trimEnd());
    const requestFrame = JSON.parse(h.sent[0]!);
    h.emit(encodeFrame({ version: 1, type: 'response', id: requestFrame.id, ok: true, result: { ok: true } }));
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('times a request out after the 30s budget', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      await h.client.start();
      const pending = h.client.request('pet.disable');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() rejects pending requests and unsubscribes', async () => {
    const h = createHarness();
    await h.client.start();
    const pending = h.client.request('pet.disable');
    await h.client.stop();
    await expect(pending).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
