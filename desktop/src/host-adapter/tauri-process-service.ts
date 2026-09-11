// Trylo Desktop — Tauri-backed ProcessService. See
// the architecture doc §2.2 + §3 Phase 2 task #3+#4.
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
} from './process-service';
import type { ProcessId } from './types';

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
    onOutput: (line: string) => void;
    onExit?: (info: ProcessExitInfo) => void;
  }): Promise<ProcessHandle> {
    // v1.15.7: the Rust side uses Channel<String> (see
    // process_spawn.rs). The JS side must use the same generic —
    // Channel<ProcessOutputEvent> doesn't match and the resulting
    // onmessage would receive an undefined `msg.line`.
    const channel = new Channel<string>();
    channel.onmessage = (msg) => {
      if (msg.startsWith(EXIT_PREFIX)) {
        // A malformed exit frame from our own Rust side would
        // otherwise throw inside the Channel callback. Degrade to a
        // warning instead of breaking the whole stdout stream (P2-1).
        try {
          opts.onExit?.(JSON.parse(msg.slice(EXIT_PREFIX.length)) as ProcessExitInfo);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[trylo] malformed process.exited frame:', err);
        }
        return;
      }
      opts.onOutput(msg);
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
      onOutput: channel,
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
}

export const tauriProcessService: ProcessService = new TauriProcessService();