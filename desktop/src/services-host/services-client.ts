// Trylo Desktop — Service Host client (renderer side).
//
// Wraps the Tauri boundary: `servicehost_send` (D→S frames) and the
// `servicehost://frame` event (S→S frames). Provides request/response
// correlation with a 30s timeout (spec §5.4) and typed event subscription.
// Tauri APIs are injected so vitest can drive the client without a
// webview.

import { decodeFrameLine, encodeFrame, nextRequestId } from './frames';
import type { ErrorResponseFrame, Frame } from './frames';
import type { ServiceEventMap, ServiceEventTopic, ServiceMethodName, ServiceMethodMap } from './methods';

export const REQUEST_TIMEOUT_MS = 30_000;

/** Per-call timeout override. The 30s default (spec §5.4) fits config-sized
 *  requests; long-running sidecar JOBS — package installs stream large
 *  pinned artifacts, uv sync may budget 10 minutes alone — need a bigger
 *  budget, or the renderer would give up while the sidecar work continues. */
export interface RequestOptions {
  readonly timeoutMs?: number;
}

export class ServiceRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ServiceRequestError';
    this.code = code;
  }
}

/** The Tauri surface this client touches (mocked in tests). */
export interface ServicesClientDeps {
  readonly invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly listen: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;
}

interface PendingRequest {
  readonly id: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (payload: unknown) => void;

export class ServicesClient {
  private readonly deps: ServicesClientDeps;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private unsubscribe: (() => void) | null = null;
  private started = false;
  /** Fired when a send fails at the transport layer (host likely gone) —
   *  the ServiceManager uses this as its crash signal. */
  onConnectionError: (() => void) | null = null;

  constructor(deps: ServicesClientDeps) {
    this.deps = deps;
  }

  /** Subscribes to the frame event. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribe = await this.deps.listen('servicehost://frame', (event) => {
      this.handleRawFrame(event.payload);
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.started = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ServiceRequestError('NOT_CONNECTED', 'service host client stopped'));
    }
    this.pending.clear();
  }

  /** Typed request/response. Rejects with ServiceRequestError on error
   *  frames, timeouts, or transport failures. */
  async request<M extends ServiceMethodName>(
    method: M,
    params?: ServiceMethodMap[M]['params'],
    options?: RequestOptions,
  ): Promise<ServiceMethodMap[M]['result']> {
    const id = nextRequestId();
    const line = encodeFrame({ version: 1, type: 'request', id, method, params });
    return this.sendLine(id, line, options?.timeoutMs) as Promise<ServiceMethodMap[M]['result']>;
  }

  /** Typed event subscription. Returns the unsubscribe function. */
  onEvent<K extends ServiceEventTopic>(topic: K, handler: (payload: ServiceEventMap[K]) => void): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as EventHandler);
    return () => {
      set?.delete(handler as EventHandler);
    };
  }

  private sendLine(id: string, line: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ServiceRequestError('TIMEOUT', `service host request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        id,
        resolve,
        reject,
        timer,
      });
      this.deps
        .invoke('servicehost_send', { frame: line })
        .then(() => {
          // Frame accepted by the shell; the response arrives via
          // servicehost://frame. Send-level failure rejects below.
        })
        .catch((err: unknown) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          const message = err instanceof Error ? err.message : String(err);
          pending.reject(new ServiceRequestError('NOT_CONNECTED', message));
          this.onConnectionError?.();
        });
    });
  }

  private handleRawFrame(payload: unknown): void {
    // The Rust side emits the raw stdout line as a string payload.
    const line = typeof payload === 'string' ? payload : '';
    const frame: Frame | null = line ? decodeFrameLine(line) : null;
    if (!frame) return;
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        const errorFrame = frame as ErrorResponseFrame;
        pending.reject(new ServiceRequestError(errorFrame.error.code, errorFrame.error.message));
      }
      return;
    }
    if (frame.type === 'event') {
      const set = this.handlers.get(frame.topic);
      if (!set) return;
      for (const handler of set) handler(frame.payload);
    }
    // ping/pong: the shell answers the sidecar's pings itself; nothing to
    // correlate on the renderer side.
  }
}
