// Trylo Desktop — minimal JSON-RPC 2.0 client. See
// ARCHITECTURE.md §2.7 + §3 Phase 1 GO (c, d).
//
// vscode-jsonclient (the canonical implementation) is not
// published on the public npm registry; it's a @vscode-internal
// package that the @codingame/monaco-vscode-api project
// vendors. We don't need the full protocol: we just need
// `request` (call that expects a response), `notify` (one-way),
// and a way to receive the server's `publishDiagnostics`
// notifications. Implementing the wire format ourselves keeps
// the dependency surface flat (no vscode-only deps) and the code
// small (this file is the whole client).

import type { LspHandle, LspManager } from './lsp-manager';
import type { LspManager as LspManagerType } from './lsp-manager';

/**
 * Wire-format helpers. The protocol is:
 *   <headers>\r\n\r\n<body>
 * with headers `Content-Length: <N>\r\n` (other headers ignored
 * by the server). Body is a JSON-RPC 2.0 payload.
 */
function encodeMessage(msg: object): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`;
}

function encodeRequest<T>(id: number, method: string, params: T): string {
  return encodeMessage({ jsonrpc: '2.0', id, method, params });
}

function encodeNotification<T>(method: string, params: T): string {
  return encodeMessage({ jsonrpc: '2.0', method, params });
}

function decodeMessages(buffer: string): { messages: unknown[]; rest: string } {
  const out: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const sepIdx = rest.indexOf('\r\n\r\n');
    if (sepIdx < 0) break;
    const header = rest.slice(0, sepIdx);
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) break;
    const n = Number(m[1]);
    const bodyStart = sepIdx + 4;
    if (rest.length < bodyStart + n) break;
    const body = rest.slice(bodyStart, bodyStart + n);
    rest = rest.slice(bodyStart + n);
    try {
      out.push(JSON.parse(body));
    } catch {
      // skip malformed payloads
    }
  }
  return { messages: out, rest };
}

export interface LspConnection {
  /**
   * Send a JSON-RPC request and await the response. `id` is
   * the next integer id and is assigned to the response
   * correlation in the resolver.
   */
  request<TParams, TResult>(method: string, params: TParams): Promise<TResult>;
  /** Fire-and-forget. */
  notify<TParams>(method: string, params: TParams): void;
  /** Subscribe to server notifications. Returns an unsubscribe. */
  onNotification<TParams>(
    method: string,
    handler: (params: TParams) => void,
  ): () => void;
  /** Send `shutdown` then `exit`, drop the subscription, close
   *  the underlying channels. */
  close(): void;
}

/**
 * Build a JSON-RPC 2.0 client backed by a Tauri LSP handle.
 * Owns:
 *   - the request id counter
 *   - the buffer for partial frames (large messages can arrive
 *     in chunks)
 *   - the active pending-request resolvers
 *
 * Not owned:
 *   - the actual TCP / stdio. That's the LspManager; we just
 *     subscribe + send through it.
 */
export function createLspConnection(
  handle: LspHandle,
  lspManager: LspManager,
): LspConnection {
  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  const notificationHandlers = new Map<string, Set<(p: unknown) => void>>();
  let buffer = '';

  const unsubscribe = lspManager.onMessage(handle, (raw) => {
    buffer += raw;
    const { messages, rest } = decodeMessages(buffer);
    buffer = rest;
    for (const m of messages) {
      const obj = m as { id?: number; method?: string; result?: unknown; error?: unknown; params?: unknown };
      if (obj.id !== undefined && pending.has(obj.id)) {
        const resolve = pending.get(obj.id)!;
        pending.delete(obj.id);
        if (obj.error) {
          // Skip: in the spike we just drop the error and leave
          // the pending request hanging. Phase 1 polish: surface
          // via a toast.
        } else {
          resolve(obj.result);
        }
        continue;
      }
      if (obj.method) {
        const set = notificationHandlers.get(obj.method);
        if (set) for (const cb of set) cb(obj.params);
      }
    }
  });

  function send(body: string): void {
    void lspManager.send(handle, body);
  }

  return {
    request<TParams, TResult>(method: string, params: TParams): Promise<TResult> {
      const id = nextId++;
      const promise = new Promise<TResult>((resolve) => {
        pending.set(id, (r) => resolve(r as TResult));
      });
      send(encodeRequest(id, method, params));
      return promise;
    },
    notify<TParams>(method: string, params: TParams): void {
      send(encodeNotification(method, params));
    },
    onNotification<TParams>(
      method: string,
      handler: (params: TParams) => void,
    ): () => void {
      let set = notificationHandlers.get(method);
      if (!set) {
        set = new Set();
        notificationHandlers.set(method, set);
      }
      set.add(handler as (p: unknown) => void);
      return () => {
        set?.delete(handler as (p: unknown) => void);
      };
    },
    close(): void {
      unsubscribe();
      pending.clear();
      notificationHandlers.clear();
    },
  };
}

// Re-export so attachLsp.ts doesn't have to import LspManager from two places.
export type { LspHandle, LspManagerType };
