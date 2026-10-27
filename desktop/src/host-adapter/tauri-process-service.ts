// Trylo Desktop — Tauri-backed ProcessService. See
// ARCHITECTURE.md §2.2 + §3 Phase 2 task #3+#4.
//
// Wraps the four Tauri commands `process_spawn`, `process_send`,
// `process_stop`, and `process_list`. Each `spawn` creates a
// per-process Tauri `Channel<string>` for the stdout stream; the
// React side holds the channel and forwards lines to the
// caller's `onOutput` callback.
//
// v1.16.6 (M4-A): stdout lines obey a reserved control-frame
// prefix `##TRYLO_PROC_EXIT##<json>` that the Rust reaper thread
// emits on child exit. It is stripped here and delivered as
// `onExit` instead of being fed to the StreamTranslator (which
// would choke on a non-model line).

import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  LiveProcessInfo,
  ProcessExitInfo,
  ProcessHandle,
  ProcessService,
  ProcessRecoveryIdentity,
  RecoverableProcess,
  RetainedProcessOutput,
} from './process-service';
import type { ProcessId } from './types';
import { createProcessExitDelivery, readProcessExit } from './process-exit-delivery';

/** Wire shape returned by `process_spawn` on the Rust side. */
interface ProcessHandleDto {
  readonly id: string;
  readonly pid: number;
  readonly label: string;
  readonly command: string;
}

/** Wire shape returned by `process_list`. */
interface ProcessInfoDto {
  readonly id: string;
  readonly label: string;
  readonly pid: number;
  readonly metadata: {
    readonly project_key?: string;
    readonly conversation_id?: string;
    readonly run_id?: string;
  };
}

/** Start of a Rust-dispatched exit control frame. */
const EXIT_PREFIX = '##TRYLO_PROC_EXIT##';

class TauriProcessService implements ProcessService {
  async spawn(opts: {
    command: string;
    args: readonly string[];
    label: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    metadata?: Readonly<{ projectKey?: string; conversationId?: string; runId?: string }>;
    recoveryIdentity?: ProcessRecoveryIdentity;
    onOutput: (line: string) => void;
    onStderr?: (line: string) => void;
    onExit?: (info: ProcessExitInfo) => void;
  }): Promise<ProcessHandle> {
    // v1.15.7: the Rust side uses Channel<String> (see
    // process_spawn.rs). The JS side must use the same generic —
    // Channel<ProcessOutputEvent> doesn't match and the resulting
    // onmessage would receive an undefined `msg.line`.
    const channel = new Channel<string>();
    const exitDelivery = createProcessExitDelivery(info => {
      try { opts.onExit?.(info); }
      catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[trylo] process.exited handler failed:', error);
      }
    });
    channel.onmessage = (msg) => {
      if (msg.startsWith(EXIT_PREFIX)) {
        // A malformed exit frame from our own Rust side would
        // otherwise throw inside the Channel callback. Degrade to a
        // warning instead of breaking the whole stdout stream (P2-1).
        const info = readProcessExit(msg.slice(EXIT_PREFIX.length));
        if (info) exitDelivery.acceptExit(info);
        else {
          // eslint-disable-next-line no-console
          console.warn('[trylo] malformed process.exited frame');
        }
        return;
      }
      opts.onOutput(msg);
    };
    // P08 §4.2: the stderr channel is ALWAYS created — Tauri's `Channel`
    // does not implement `Deserialize`, so it cannot be optional on the
    // Rust side. `captureStderr` is what actually decides: with `false`
    // the child's stderr stays `Stdio::null()` and this channel never
    // fires, so the legacy CLI's debug flood never crosses IPC.
    const stderrChannel = new Channel<string>();
    const stderrSink = opts.onStderr ?? null;
    stderrChannel.onmessage = (msg) => {
      // The `##TRYLO_PROC_EXIT##` control frame is a stdout artefact;
      // stderr never carries one. Anything arriving here is a real line.
      try { stderrSink?.(msg); }
      finally { exitDelivery.receivedStderr(); }
    };
    const dto = await invoke<ProcessHandleDto>('process_spawn', {
      command: opts.command,
      args: [...opts.args],
      label: opts.label,
      cwd: opts.cwd ?? null,
      env: opts.env ?? null,
      projectKey: opts.metadata?.projectKey ?? null,
      conversationId: opts.metadata?.conversationId ?? null,
      runId: opts.metadata?.runId ?? null,
      recoveryIdentity: opts.recoveryIdentity ?? null,
      onOutput: channel,
      onStderr: stderrChannel,
      // false ⇒ the Rust side keeps Stdio::null(); the channel above is
      // inert. Legacy callers are therefore byte-identical to before.
      captureStderr: stderrSink !== null,
    });
    return {
      id: dto.id,
      pid: dto.pid,
      label: dto.label,
      command: dto.command,
    };
  }

  async send(id: ProcessId, message: string): Promise<void> {
    await invoke('process_send', { id, message });
  }

  /** P08 §4.2: stdin EOF without killing the child. Idempotent on the
   *  Rust side, so a retry is always safe. */
  async closeInput(id: ProcessId): Promise<void> {
    await invoke('process_close_input', { id });
  }

  async stop(id: ProcessId): Promise<void> {
    await invoke('process_stop', { id });
  }

  async list(): Promise<readonly LiveProcessInfo[]> {
    const dtos = await invoke<ProcessInfoDto[]>('process_list');
    return dtos.map((d) => ({
      id: d.id,
      pid: d.pid,
      label: d.label,
      command: '',
      metadata: {
        projectKey: d.metadata?.project_key ?? undefined,
        conversationId: d.metadata?.conversation_id ?? undefined,
        runId: d.metadata?.run_id ?? undefined,
      },
    }));
  }

  recoveryList(): Promise<readonly RecoverableProcess[]> { return invoke('process_recovery_list'); }
  readOutput(id: ProcessId, afterSequence: number): Promise<RetainedProcessOutput> {
    return invoke('process_read_output', { id, afterSequence });
  }
  async hasTeamOwner(workspaceRoot: string, conversationId: string): Promise<boolean> {
    const owned = await invoke<unknown>('process_team_owner_status', { workspaceRoot, conversationId });
    if (typeof owned !== 'boolean') throw new Error('Native team ownership result is invalid.');
    return owned;
  }
}

export const tauriProcessService: ProcessService = new TauriProcessService();
