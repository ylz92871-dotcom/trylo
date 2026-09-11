// Trylo Work — Control Plane protocol types.
//
// Mirrors the upstream `vendor/cowork-os/src/electron/control-
// plane/protocol.ts` (committed 0.5.51). We re-declare the
// types here rather than import from the vendor so the
// control-plane client (`client.ts`) stays in the Work
// sub-app's public surface and doesn't pull in the vendor's
// runtime.
//
// Three frame shapes share the wire:
//   - Request:  client → server
//   - Response: server → client (carries an `id` matching a Request)
//   - Event:    server → client (broadcast, no id)
//
// We only consume Events + send Requests. Responses are
// correlated to Requests by `id`.

export const FrameType = {
  Request: "req",
  Response: "res",
  Event: "event",
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface RequestFrame {
  readonly type: "req";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseFrame {
  readonly type: "res";
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface EventFrame {
  readonly type: "event";
  readonly event: string;
  readonly payload?: unknown;
  readonly seq?: number;
  readonly stateVersion?: string;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

/**
 * Subset of the upstream event names we care about. Names
 * not listed here are still routed through the generic
 * `on('*', ...)` handler but won't get typed event payloads.
 */
export const Events = {
  ConnectSuccess: "connect.success",
  Heartbeat: "heartbeat",
  TaskCreated: "task.created",
  TaskUpdated: "task.updated",
  TaskCompleted: "task.completed",
  TaskFailed: "task.failed",
  TaskEvent: "task.event",
  CanvasContentPushed: "canvas.content_pushed",
  CanvasSessionUpdated: "canvas.session_updated",
  Shutdown: "shutdown",
} as const;
export type EventName = (typeof Events)[keyof typeof Events] | (string & {});

/**
 * Subset of methods we currently call. The daemon's full
 * catalog is in `vendor/cowork-os/src/electron/control-plane/
 * protocol.ts`.
 */
export const Methods = {
  Connect: "connect",
  Health: "health",
  Ping: "ping",
  WorkspaceList: "workspace.list",
  WorkspaceGet: "workspace.get",
  TaskList: "task.list",
  TaskEvents: "task.events",
  TaskGet: "task.get",
  TaskCancel: "task.cancel",
  TaskCreate: "task.create",
  TaskSendMessage: "task.sendMessage",
  // M4-E (architecture doc §6.3): approval / input
  // request — the daemon pauses a task awaiting a user
  // decision; Trylo surfaces the pending request inline
  // and responds here instead of letting the task fail.
  ApprovalList: "approval.list",
  ApprovalRespond: "approval.respond",
  InputRequestList: "input_request.list",
  InputRequestRespond: "input_request.respond",
  FileListDirectory: "file.listDirectory",
  LlmConfigure: "llm.configure",
} as const;
export type MethodName = (typeof Methods)[keyof typeof Methods] | (string & {});

/** Status the client reports to consumers. */
export type ClientStatus =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "connected"
  | "error";

/** Configuration for `createClient`. */
export interface ControlPlaneConfig {
  readonly url: string;
  /** Token to send during the `connect` handshake. Some
   *  deployments leave it blank; check your daemon's
   *  `--print-control-plane-token` output. */
  readonly token?: string;
  /** Auto-reconnect on disconnect. Default `true`. */
  readonly autoReconnect?: boolean;
  /** Delay between reconnect attempts in ms. Default 2000. */
  readonly reconnectDelayMs?: number;
  /** M3 closure §11.3: TOTAL deadline of a queued send,
   *  counted from enqueue. Default 30000. After expiry
   *  the queued request rejects instead of waiting
   *  forever for a connection. */
  readonly queueDeadlineMs?: number;
  /** Called on every status transition. */
  readonly onStatus?: (status: ClientStatus, error?: unknown) => void;
  /** Called for every event from the server. */
  readonly onEvent?: (event: EventFrame) => void;
}

/** Public client interface returned by `createClient`. */
export interface ControlPlaneClient {
  readonly status: () => ClientStatus;
  readonly connect: () => void;
  readonly disconnect: () => void;
  /** Send a method call. Resolves on response, rejects on
   *  timeout (default 10s) or server-side error.
   *
   *  v1.16.5+ (M3): if the socket is not yet OPEN, the
   *  request is held in an internal queue and flushed when
   *  the handshake completes. Replaces the previous
   *  behaviour, which silently dropped the request.
   *
   *  M3 closure §11.3: queued requests carry a TOTAL
   *  deadline from enqueue (config.queueDeadlineMs), and a
   *  send issued while disconnected restarts the
   *  connection attempt — never queue without connect. */
  readonly send: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  /** v1.16.5+ (M5): one-shot promise that resolves when
   *  the client reaches the "connected" state (handshake
   *  done), or rejects on close / error / timeout. Useful
   *  for renderer code that wants to surface a clear
   *  failure when the daemon never comes up. */
  readonly whenReady: (timeoutMs?: number) => Promise<void>;
  /** Subscribe to a specific event. Returns an unsubscribe fn.
   *  Use `'*'` to receive every event. */
  readonly on: (event: EventName | "*", handler: (frame: EventFrame) => void) => () => void;
}
