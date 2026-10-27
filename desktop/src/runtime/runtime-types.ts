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
import type { CliRuntimeProtocol } from './cli-runtime-protocol';
import type { ReasoningEffort } from '../settings/reasoning-effort';

/**
 * The resolved settings a CodeRunController needs to spawn or to
 * rewrite a prompt. App builds this from the user's TryloSettings
 * on each send — keeping the controller decoupled from the
 * settings store shape.
 */
export interface SettingsForCodeRun {
  readonly cliPath: FilePath;
  readonly cwd: FilePath;
  /**
   * WP-CL / B: the effective user-learning setting for THIS run, forwarded to
   * the CLI as `--learning=<value>`.
   *
   * `undefined` is not "off by policy" — it is "nothing was enabled", and the
   * argv stays byte-for-byte what it was before learning existed. The Desktop
   * must never substitute a default: `all` would turn on method and tool
   * learning the user never asked for.
   */
  readonly learning?: 'method' | 'user' | 'all';
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  /** Account-owned free pool; resolved into an ephemeral local connection at spawn. */
  readonly platformModel?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextTokenLimit?: number;
  readonly modelContextWindow?: number;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly systemPrompt?: string;
  /**
   * P08 §3.4: which new-CLI provider this run selects. Empty ⇒ the CLI's
   * own default (fixture in the dev path). Never a credential — the new
   * CLI reads its own ledger.
   */
  readonly providerId?: string;
  /**
   * P08 §4.1: which CLI runtime contract this run speaks. Part of the
   * snapshot because it is fixed at spawn time — a mid-run settings
   * change must not retarget a live process.
   */
  readonly cliRuntimeProtocol?: CliRuntimeProtocol;
  /**
   * P08 §WP6: the Node interpreter that runs `cliPath`, resolved in the
   * same step as the path itself. Kept together deliberately — a pinned
   * Node that never reaches the spawn is the same as no pinned Node.
   */
  readonly cliNodeProgram?: string;
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
