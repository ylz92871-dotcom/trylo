// Trylo Desktop — Companion projection (migration spec §6.3).
//
// The ONLY new mapping layer between Desktop run state and the legacy pet
// protocol: Code/Work domain states → the `publish` payloads the legacy
// bridge accepts (agentState / permissionRequestState / assistant /
// stopped / error). Pure functions, table-driven tests; the WPF keeps its
// own state names and animation selection — we only speak its vocabulary.
//
// The agentState vocabulary is the legacy AGENT_STATES set
// (extension.js ~409-421); PetWindow's animation picker understands
// exactly these strings (PetWindow.xaml.cs StateLabel/IsWorkingState).

import type { LoopEvent } from '../host-adapter/loop-events';
import type { CodeRunBindingState } from '../runtime/runtime-types';
import type { CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { CompanionPublishPayload, PetPermissionRequest } from './companion-port';

/** Legacy AGENT_STATES (frozen; tests pin it). */
export const AGENT_STATES = Object.freeze({
  idle: 'idle',
  thinking: 'thinking',
  planning: 'planning',
  writingFiles: 'writing_files',
  runningCommand: 'running_command',
  waitingOutput: 'waiting_output',
  programRunning: 'program_running',
  stalled: 'stalled',
  done: 'done',
  failed: 'failed',
});

/** Code run binding state → pet state. Spawning reads as "planning" (the
 *  brief CLI boot); busy falls back to "thinking" until a loop event
 *  refines it (see projectLoopEventToState). */
export function projectCodeBindingState(state: CodeRunBindingState): string {
  switch (state) {
    case 'spawning':
      return AGENT_STATES.planning;
    case 'busy':
      return AGENT_STATES.thinking;
    case 'ready':
    case 'idle':
    case 'exited':
      return AGENT_STATES.idle;
  }
}

/** Tool name → working state, mirroring the legacy state-derivation
 *  (extension.js ~5677-5695): commands run in a terminal, file tools
 *  write, everything else reads as model thinking. */
export function projectToolUseToState(toolName: string): string {
  const tool = String(toolName || '').toLowerCase();
  if (tool === 'bash' || tool === 'run_command' || tool.includes('terminal')) {
    return AGENT_STATES.runningCommand;
  }
  if (
    tool === 'write' ||
    tool === 'edit' ||
    tool === 'notebookedit' ||
    tool.includes('write') ||
    tool.includes('edit') ||
    tool.includes('patch')
  ) {
    return AGENT_STATES.writingFiles;
  }
  return AGENT_STATES.thinking;
}

/** Loop event → refined pet state while a run is in flight. Returns null
 *  for events that carry no pet-visible transition. */
export function projectLoopEventToState(event: LoopEvent): string | null {
  switch (event.type) {
    case 'thinking':
    case 'text':
    case 'api_stream':
    case 'api_call':
    case 'tool_result':
      return AGENT_STATES.thinking;
    case 'tool_use':
      return projectToolUseToState(event.tool);
    default:
      return null;
  }
}

/** Loop event → a short human description of WHAT the run is doing right
 *  now (the pet bubble shows it as the running task). Kept terse: a file
 *  name for file tools, the first command token for Bash. Null when the
 *  event carries nothing worth showing. */
export function projectLoopEventDetail(event: LoopEvent): string | null {
  if (event.type !== 'tool_use') return null;
  const input = (event.input ?? {}) as Record<string, unknown>;
  const tool = String(event.tool || '').toLowerCase();
  const filePath = input['file_path'] ?? input['path'] ?? input['notebook_path'];
  if (typeof filePath === 'string' && filePath !== '') {
    const segments = filePath.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? filePath;
  }
  if (tool === 'bash' || tool.includes('command') || tool.includes('terminal')) {
    const command = input['command'];
    if (typeof command === 'string' && command.trim() !== '') {
      const firstLine = command.trim().split('\n')[0]!.trim();
      return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
    }
  }
  const pattern = input['pattern'];
  if (typeof pattern === 'string' && pattern !== '') return pattern;
  return null;
}

/** Code run terminal outcome → the closing publish payload. */
export function projectCodeOutcome(outcome: CodeRunOutcome): CompanionPublishPayload {
  switch (outcome) {
    case 'completed':
      return { type: 'assistant' };
    case 'failed':
      return { type: 'error', message: 'Code run failed' };
    case 'cancelled':
    case 'exited':
      return { type: 'stopped' };
  }
}

// ── Work item flow (spec §6.3: Work item 状态 → 同一张映射表) ────────

/** The approval item the Work event presenter emits (@trylo/work). */
export interface WorkApprovalItemLike {
  readonly kind: 'approval';
  readonly approvalId: string;
  readonly type?: string | undefined;
  readonly description: string;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly autoApproved?: boolean;
}

/** approval(pending) item → the pet permission request. `requestId` comes
 *  from the approval itself (the workd approvalId) — never from the UI's
 *  current selection (spec §6.3 双工作区红线). Returns null for resolved
 *  / auto-approved items. */
export function workApprovalToPetRequest(item: WorkApprovalItemLike): PetPermissionRequest | null {
  if (item.status !== 'pending' || item.autoApproved === true) return null;
  return {
    requestId: item.approvalId,
    title: item.type || 'Permission required',
    detail: item.description,
    description: item.description,
    category: 'edit',
    approvalState: 'pending',
  };
}

/** Build the permissionRequestState payload from the CURRENT pending set
 *  (bridge picks the first pending entry onto its UDP envelope). Publishing
 *  the (possibly empty) full set is also how approvals get cleared. */
export function permissionRequestStatePayload(
  requests: readonly PetPermissionRequest[],
): CompanionPublishPayload {
  return { type: 'permissionRequestState', requests };
}

/** Work tool item running → working animation. Commands run in a
 *  terminal; everything else reads as writing. */
export function workToolItemToState(title: string): string {
  const t = String(title || '').toLowerCase();
  if (t.includes('command') || t.includes('terminal') || t.includes('bash') || t.includes('shell')) {
    return AGENT_STATES.runningCommand;
  }
  return AGENT_STATES.writingFiles;
}
