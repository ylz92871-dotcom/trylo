// Trylo Desktop — shared runtime types.
//
// v1.16.6 (M4-A runtime ownership, specs
// CODE-WORK-NEXT-STAGE-ARCHITECTURE-2026-08-27.md §4.1/§4.2):
// the ONLY place the visible Code run state is produced. React no
// longer owns `running` / `sendingDisabled` / `activeProcessId` /
// `error` at App-top; a controller keyed by
// (projectKey, conversationId) owns them, and components read a
// per-conversation ViewState.

import type { FilePath, ProcessId } from '../host-adapter/types';

/**
 * The resolved settings a CodeRunController needs to spawn or to
 * rewrite a prompt. App builds this from the user's TryloSettings
 * on each send — keeping the controller decoupled from the
 * settings store shape.
 */
export interface SettingsForCodeRun {
  readonly cliPath: FilePath;
  readonly cwd: FilePath;
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly systemPrompt?: string;
}

/** Spec §4.2: CodeRunBinding.state. */
export type CodeRunBindingState =
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'exited';

/** The per-conversation Code run state React renders from. */
export interface CodeRunViewState {
  /** True while a Code CLI run is in flight for THIS
   *  conversation (spawning or producing output). */
  readonly running: boolean;
  /** Spawn / in-flight failure of THIS conversation's run. */
  readonly error: boolean;
  /** Host process handle, present while the CLI is alive. */
  readonly activeProcessId: ProcessId | null;
  /** False while a run is in flight — the InputBar gate. */
  readonly sendable: boolean;
  /** Spec §4.2 binding state. */
  readonly bindingState: CodeRunBindingState;
  /** Crafted by this controller for attribution on the next
   *  `process.exited` frame. Null until a run starts. */
  readonly runId: string | null;
  /** OS pid of the live child, when known. */
  readonly pid: number | null;
}

/** A run in flight for the Activity Center (M4-A minimal). */
export interface ActiveCodeRun {
  readonly projectKey: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly bindingState: CodeRunBindingState;
}

export const IDLE_CODE_VIEW_STATE: CodeRunViewState = {
  running: false,
  error: false,
  activeProcessId: null,
  sendable: true,
  bindingState: 'idle',
  runId: null,
  pid: null,
};