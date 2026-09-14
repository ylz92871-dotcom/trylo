// Trylo Desktop — WorkChatAdapter.
//
// 2026-08-30 (WORK-CHAT-ROUTING-FIX phase 1 step 7): a thin adapter
// that routes a Work conversation (ordinary chat) through the stable
// Code runtime (ConversationRunSupervisor.runCode) instead of the
// workd daemon's full task pipeline. No Code-side module is modified
// (desktop/src/runtime/ and trylo-runner.ts are zero-diff).

import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import type { SettingsForCodeRun } from '../runtime/runtime-types';
import type { PermissionLevel } from '../permission/permission-policy';
import type { ResolvedToolRuntime } from '../services-host/methods';
import type { ChatMessage } from '../components/chat/types';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { CodeRunLifecycleObserver } from '../runtime/code-run-lifecycle';

export interface WorkChatSendOptions {
  readonly projectKey: string;
  readonly conversationId: string;
  readonly text: string;
  readonly settings: SettingsForCodeRun;
  readonly permissionLevel: PermissionLevel;
  readonly priorMessages: readonly ChatMessage[];
  readonly turnId?: string;
  /** Interaction intent for the Code CLI. The P0 Work surface sends every
   *  message as 'agent' and lets the model decide tool use from the single
   *  Work system contract (see `systemPrompt`). */
  readonly codeMode?: 'plan' | 'agent' | 'chat';
  /** Optional system-prompt override handed to the CLI for this run. When
   *  present it wins over `settings.systemPrompt`, so a Work conversation can
   *  install its Work profile (identity + workspace + `.trylo/out` rule)
   *  without disturbing the user's global Code system prompt. */
  readonly systemPrompt?: string;
  /**
   * The Tool Profile this Work send requests (tool-extension spec §4.1).
   * Defaults to `work.core.v1`. Explicit — Work must never inherit the
   * Code surface's undecorated Hermes args (§4.3).
   */
  readonly requestedProfileId?: string;
  /**
   * P0-A (audit §3.3-5): an ALREADY-resolved runtime from the caller's
   * pre-send capability gate. Passing it makes the run use the exact
   * Profile the gate inspected (single resolve; the gate and the run can
   * never disagree). Omit → the supervisor resolves as before.
   */
  readonly toolRuntime?: ResolvedToolRuntime | null;
  /** 电脑控制 switch (`settings.workComputer`). `false` drops the Windows
   *  desktop-control package from the resolved Work Profile (used when the
   *  caller did not pre-resolve a `toolRuntime`). */
  readonly computerUse?: boolean;
  readonly onEvents: (events: readonly LoopEvent[]) => void;
  readonly lifecycleObserver?: CodeRunLifecycleObserver;
}

export function sendWorkChat(
  supervisor: ConversationRunSupervisor,
  options: WorkChatSendOptions,
): Promise<void> {
  const { settings, systemPrompt } = options;
  return supervisor.runCode(options.projectKey, options.conversationId, {
    prompt: options.text,
    settings: systemPrompt !== undefined
      ? { ...settings, systemPrompt }
      : settings,
    codeMode: options.codeMode ?? 'agent',
    permissionLevel: options.permissionLevel,
    priorMessages: options.priorMessages,
    turnId: options.turnId,
    // §4.1/§4.3: Work asks for its own Profile instead of silently sharing
    // the Code surface's `normal` Hermes argv. `surface: 'work'` alone would
    // already pick the default, but the explicit id keeps the intent visible
    // at every call site and lets a caller opt into a specialty Profile
    // (e.g. `work.cad.v1`).
    surface: 'work',
    requestedProfileId: options.requestedProfileId ?? 'work.core.v1',
    ...(options.computerUse !== undefined ? { computerUse: options.computerUse } : {}),
    ...(options.toolRuntime !== undefined ? { toolRuntime: options.toolRuntime } : {}),
    onEvents: options.onEvents,
    lifecycleObserver: options.lifecycleObserver,
  });
}