// Trylo Desktop — Trylo API types. See ARCHITECTURE.md §3 Phase 2.
//
// The Trylo API is the contract between the legacy 4-mode webview
// (running in an iframe) and the new Tauri desktop shell. The webview
// sees `window.acquireTryloApi()` returning a `TryloApi`; the React
// side implements it. Every message type lands here so the surface
// is grep-able from one file.
//
// Phase 2 first batch (arch §3 Phase 2 task #8): six "simple" types.
// The complex types (sendPrompt, requestSkillsState, ...) ship in
// later weeks. New types are added by:
//   1. Adding the type union to `TryloRequest` / `TryloResponse`.
//   2. Adding a handler in `trylo-message-types.ts`.
//   3. Adding a unit test in `trylo-message-types.test.ts`.
//   4. (If the type has a server-push component) adding the push
//      event to `TryloPushEvent`.

import type { FilePath } from './types';

// ── Trylo API surface ─────────────────────────────────────────────────────

export interface TryloApi {
  /**
   * Send a request to the desktop shell. Resolves with the response.
   * Rejects if the message type is unknown or the handler throws.
   */
  postMessage<TReq extends TryloRequest, TRes extends TryloResponse>(
    message: TReq,
  ): Promise<TRes>;

  /**
   * Subscribe to server-pushed events. The handler is called for every
   * event the shell pushes back into the iframe (agent text deltas,
   * file change notifications, etc.). Returns an unsubscribe function.
   */
  onMessage<TMsg extends TryloPushEvent>(
    handler: (msg: TMsg) => void,
  ): () => void;

  /**
   * Legacy compatibility. Maps to the iframe-side `vscode.getState()`
   * and `vscode.setState()`. Phase 2: backed by an in-memory map keyed
   * by the iframe's session id. Phase 3: backed by Project State.
   */
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

// ── Request types (iframe → shell) ────────────────────────────────────────
//
// The first six are the "simple" batch from arch §3 Phase 2 task #8.
// They are sufficient to mount the legacy webview, create a session,
// switch modes, list sessions, test the LLM route, and clear an API
// key. The complex types (sendPrompt, skills, office, fun, review) are
// deferred to Phase 2 weeks 2-4 or Phase 3.

export type TryloRequest =
  | InitRequest
  | CreateSessionRequest
  | SwitchSessionRequest
  | DeleteSessionRequest
  | GetSessionsRequest
  | ModeChangedRequest
  | SetPermissionModeRequest
  | TestConnectionRequest
  | ClearApiKeyRequest
  | ClearVisionApiKeyRequest;

export interface InitRequest {
  readonly type: 'init';
}

export interface CreateSessionRequest {
  readonly type: 'createSession';
}

export interface SwitchSessionRequest {
  readonly type: 'switchSession';
  readonly sessionId: string;
}

export interface DeleteSessionRequest {
  readonly type: 'deleteSession';
  readonly sessionId: string;
}

export interface GetSessionsRequest {
  readonly type: 'getSessions';
}

export interface ModeChangedRequest {
  readonly type: 'modeChanged';
  readonly mode: TryloMode;
}

export interface SetPermissionModeRequest {
  readonly type: 'setPermissionMode';
  readonly permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

export interface TestConnectionRequest {
  readonly type: 'testConnection';
}

export interface ClearApiKeyRequest {
  readonly type: 'clearApiKey';
}

export interface ClearVisionApiKeyRequest {
  readonly type: 'clearVisionApiKey';
}

// ── Response types (shell → iframe) ───────────────────────────────────────

export type TryloResponse =
  | InitResponse
  | CreateSessionResponse
  | SwitchSessionResponse
  | DeleteSessionResponse
  | GetSessionsResponse
  | ModeChangedResponse
  | SetPermissionModeResponse
  | TestConnectionResponse
  | ClearApiKeyResponse
  | ClearVisionApiKeyResponse;

export interface InitResponse {
  readonly type: 'init';
  readonly ok: true;
  readonly sessionId: string;
  readonly mode: TryloMode;
  readonly workspaceRoot: FilePath;
}

export interface CreateSessionResponse {
  readonly type: 'createSession';
  readonly ok: true;
  readonly sessionId: string;
}

export interface SwitchSessionResponse {
  readonly type: 'switchSession';
  readonly ok: true;
}

export interface DeleteSessionResponse {
  readonly type: 'deleteSession';
  readonly ok: true;
}

export interface GetSessionsResponse {
  readonly type: 'getSessions';
  readonly sessions: readonly TryloSession[];
}

export interface ModeChangedResponse {
  readonly type: 'modeChanged';
  readonly ok: true;
  readonly mode: TryloMode;
}

export interface SetPermissionModeResponse {
  readonly type: 'setPermissionMode';
  readonly ok: true;
  readonly permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

export interface TestConnectionResponse {
  readonly type: 'testConnection';
  readonly ok: boolean;
  readonly message: string;
}

export interface ClearApiKeyResponse {
  readonly type: 'clearApiKey';
  readonly ok: true;
}

export interface ClearVisionApiKeyResponse {
  readonly type: 'clearVisionApiKey';
  readonly ok: true;
}

// ── Server-pushed events (shell → iframe) ─────────────────────────────────
//
// Phase 2 ships empty. Phase 2 weeks 2-4 will add `agentDelta`,
// `fileChanged`, `sessionCreated`, etc. The `onMessage` API is stable
// so the iframe can subscribe before the events exist.

export type TryloPushEvent = never;

// ── Shared types ──────────────────────────────────────────────────────────

export type TryloMode = 'plan' | 'agent' | 'chat' | 'cognition' | 'office' | 'fun';

export interface TryloSession {
  readonly id: string;
  readonly title: string;
  readonly mode: TryloMode;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Total turns in the session. */
  readonly turnCount: number;
  /**
   * v1.16.5+ (W-RUN-005, Phase B4 of the M1 lifecycle
   * milestone): the daemon taskId bound to this session
   * (for Work conversations). Set by `workRuntime.startTask`
   * after a successful `task.create`; cleared by the
   * reconciler once the task reaches a terminal state.
   * Refresh recovery (B4) reads this to re-bind
   * non-terminal tasks after a Desktop reload.
   */
  readonly taskId?: string;
  /**
   * v1.16.5+ (M3 closure, spec §2.2/§5.2): the id of the
   * user message that started the bound run. Persisted
   * together with taskId so refresh recovery rebuilds the
   * RunBinding's turnId from the binding itself — never
   * guessed from "the latest user message" (M3-P1-02).
   */
  readonly turnId?: string;
  /**
   * v1.16.5+ (Work end-to-end workflow redesign spec §2.3):
   * the snapshotted turn intent. `conversation` answers
   * directly and must not execute; `task` is an explicit
   * work order. Persisted alongside `taskId` / `turnId` so
   * refresh recovery restores the intent instead of
   * rediscovering it from tool events. Absent on legacy
   * sessions (consumers fall back to the `isChat` mapping).
   */
  readonly intent?: 'conversation' | 'task';
}
