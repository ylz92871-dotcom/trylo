import type { ProcessService, ProcessHandle } from './process-service';
import { cliSpawnCommand } from './cli-runtime-path';
import type { FilePath } from './types';
import { parseControlFrame, type ControlFrame } from './control-protocol';
import { registeredProcessIds } from './process-snapshot';

/** Supplied by the existing permission owner, never by a command payload. */
export type CliCommandStartState = 'ready' | 'binding' | 'stopping' | 'stop_unconfirmed';
export type CliCommandControlPort = {
  readonly receive: (frame: ControlFrame, processId: string) => void;
  readonly clearProcess: (processId: string) => void;
  /** Reserve ownership before awaiting a native handle. The token is local to this owner. */
  readonly starting?: (stop: () => Promise<void>) => string;
  readonly acquired?: (handle: ProcessHandle, stop: () => Promise<void>, reservationId?: string,
    confirmExit?: () => Promise<boolean>) => void;
  /** A rejected spawn promise is terminal: it cannot later return a handle. */
  readonly spawnRejected?: (reservationId: string) => void;
  readonly stopping?: (processId: string) => void;
  readonly stopUnconfirmed?: (processId: string, reason: string) => void;
  readonly exited?: (processId: string, reservationId?: string) => void;
  readonly canStart?: () => boolean;
  /** The original owner distinguishes normal handle binding from an unresolved stop. */
  readonly startState?: () => CliCommandStartState;
  readonly subscribe?: (listener: () => void) => () => void;
  /** Read-only reconciliation of retained children; never stops a live process. */
  readonly reconcile?: () => Promise<void>;
  /** Trusted local UI evidence only; the existing registry must still own and
   * answer this exact pending process request. Never sourced from command JSON. */
  readonly respondToUserAction?: (frame: Extract<ControlFrame, { kind: 'permission' }>, processId: string) => Promise<boolean>;
};
/** Recovery key owned by Supervisor: a pending reservation until the actual native handle arrives. */
export type CliCommandRetainedStatus = { readonly processId: string; readonly workspaceRoot: string;
  readonly state: 'stopping' | 'stop_unconfirmed'; readonly error?: string };
export type CliCommandRecoveryPort = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly statuses: () => readonly CliCommandRetainedStatus[];
  readonly retry: (processId: string) => Promise<void>;
};

export type CliCommandInput = {
  readonly process: Pick<ProcessService, 'spawn' | 'stop'> & Partial<Pick<ProcessService, 'send' | 'closeInput' | 'list'>>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  /** Host-owned environment for a specific CLI invocation; never derived from model tool arguments. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly control?: CliCommandControlPort;
  /** Lifecycle ownership without changing a command's EOF/JSON protocol. */
  readonly lifecycle?: CliCommandControlPort;
  /**
   * 取消后等引擎自己收尾的时长。产品用默认值；固定时间线的测试传小值，
   * 这样"多久算收不了尾"只有一处定义。
   */
  readonly cancelGraceMs?: number;
};
export type CliCommandResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string; readonly stdout?: string };

/**
 * 取消一次命令时，先给引擎多长时间自己收尾。
 *
 * 中断不是"立刻消失"：引擎要停掉在跑的工具、把结论写进日志、结算已经发出去的
 * 副作用。被杀掉的进程什么都写不了，留下的是"一步操作发出去了、结果没记下来"。
 *
 * 但这两个要求是对立的：等得久，别人收不了尾时"停止"这按钮就像失灵。这里是
 * 上限而不是延迟——进程一退出就立刻返回，只有赖着不走才等满。5 秒够停掉还在跑
 * 的子进程树并写完终态，又不至于让人觉得点了没反应；停止期间界面显示"正在停止"。
 */
const CANCEL_SETTLE_MS = 5000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process_stop_deadline')), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Shared one-shot transport. Domain consumers decode their own versioned CLI replies. */
export async function runCliCommand(input: CliCommandInput): Promise<CliCommandResult> {
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };
  const { command, prefix } = cliSpawnCommand(input.cliPath, input.nodeProgram);
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return { ok: false, reason: 'invalid_timeout' };
  const lifecycle = input.lifecycle ?? input.control;
  return new Promise(resolve => {
    let settled = false, bytes = 0, stderr = '', stopWhenReady = false;
    let handle: Promise<ProcessHandle> | undefined, owned: ProcessHandle | undefined, stopped = false;
    let reservationId: string | undefined;
    const lines: string[] = [];
    const pendingControls: ControlFrame[] = [];
    let actualExit = false, endingReason: string | undefined, ending: Promise<void> | undefined, stopping: Promise<void> | undefined;
    let markExit!: () => void;
    const exit = new Promise<void>(resolveExit => { markExit = resolveExit; });
    const releaseExited = (id: string): void => {
      actualExit = true; markExit(); lifecycle?.exited?.(id, reservationId);
    };
    const confirmExit = async (): Promise<boolean> => {
      if (actualExit) return true;
      const child = owned;
      if (!child || !input.process.list) return false;
      let absent: boolean;
      try {
        absent = await within(Promise.race([exit.then(() => true),
          input.process.list().then(rows => !registeredProcessIds(rows).has(child.id))]), 1000);
      } catch {
        // An unavailable/malformed registry cannot release ownership; a real exit can.
        return actualExit;
      }
      // A late list response has no effects. Absence says nothing about output/code.
      if (absent && !actualExit) releaseExited(child.id);
      return actualExit;
    };
    const stop = (): void => {
      stopWhenReady = true;
      if (owned !== undefined && !stopped) {
        stopped = true;
        void input.process.stop(owned.id).catch(() => {
        // Terminal query failure is already reported; the process supervisor owns cleanup.
        });
      }
    };
    const finish = (result: CliCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      pendingControls.length = 0;
      try { if (owned) lifecycle?.clearProcess(owned.id); }
      catch { result = { ok: false, reason: 'approval_cleanup_failed' }; }
      resolve(result);
    };
    const stopControlled = (): Promise<void> => {
      endingReason ??= 'cancelled';
      if (actualExit) return Promise.resolve();
      const pendingId = owned?.id ?? reservationId;
      if (pendingId !== undefined) lifecycle?.stopping?.(pendingId);
      stopping ??= (async () => {
        const child = owned ?? await within(handle ?? Promise.reject(new Error('process_handle_pending')), 5000);
        if (!child) throw new Error('process_handle_pending');
        if (await confirmExit()) return;
        lifecycle?.stopping?.(child.id);
        lifecycle?.clearProcess(child.id);
        try { await within(input.process.send?.(child.id, `${JSON.stringify({ type: 'control_request', request_id: `interrupt-${child.id}`,
          request: { subtype: 'interrupt' } })}\n`) ?? Promise.resolve(), 1000); } catch { /* Force stop still uses the original process owner. */ }
        try { await within(exit, input.cancelGraceMs ?? CANCEL_SETTLE_MS); return; } catch { /* No exit receipt yet. */ }
        try {
          await within(input.process.stop(child.id), 3000);
          await within(exit, 1500);
        } catch (error) {
          if (await confirmExit()) return;
          throw error;
        }
      })().finally(() => { stopping = undefined; });
      return stopping;
    };
    const fail = (reason: string): void => {
      if (!lifecycle) { stop(); finish({ ok: false, reason }); return; }
      endingReason ??= reason;
      if (ending) return;
      clearTimeout(timer);
      ending = stopControlled().then(() => finish({ ok: false, reason: endingReason! }), error => {
        const pendingId = owned?.id ?? reservationId;
        if (pendingId !== undefined) lifecycle?.stopUnconfirmed?.(pendingId, error instanceof Error ? error.message : 'process_stop_unconfirmed');
        finish({ ok: false, reason: 'stop_unconfirmed' });
      }).finally(() => { ending = undefined; });
    };
    const abort = (): void => fail('cancelled');
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      reservationId = lifecycle?.starting?.(stopControlled);
      if (input.signal?.aborted) {
        if (reservationId !== undefined) lifecycle?.spawnRejected?.(reservationId);
        finish({ ok: false, reason: 'cancelled' }); return;
      }
      handle = input.process.spawn({ command, args: [...prefix, ...input.args], label: `trylo-${input.args[0] ?? 'query'}-${input.args[1] ?? 'command'}`, cwd: input.cwd,
        ...(input.env === undefined ? {} : { env: input.env }),
        onOutput: line => {
          if (settled || endingReason !== undefined) return;
          bytes += line.length + 1;
          if (bytes > 1_048_576) { fail('output_limit'); return; }
          if (input.control) {
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { /* The domain parser rejects malformed replies. */ }
            const frame = parseControlFrame(parsed);
            if (frame) {
              try {
                if (owned) input.control.receive(frame, owned.id);
                else if (pendingControls.length < 16) pendingControls.push(frame);
                else fail('approval_buffer_limit');
              } catch { fail('approval_transport_failed'); }
              return;
            }
            if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
              // Warnings are not a successful library result. Unknown control traffic fails closed.
              if (parsed.type === 'warning') return;
              fail('invalid_library_control_frame'); return;
            }
          }
          lines.push(line);
        },
        onStderr: line => { if (!settled) stderr = `${stderr}${line}\n`.slice(0, 8_192); },
        onExit: info => {
          releaseExited(info.id);
          if (endingReason !== undefined) { finish({ ok: false, reason: endingReason }); return; }
          if (info.outputComplete === false) { finish({ ok: false, reason: 'incomplete_output' }); return; }
          finish(info.code === 0 ? { ok: true, stdout: lines.join('\n') }
            : { ok: false, reason: `exit_${String(info.code ?? 'signal')}${stderr.trim() === '' ? '' : `:${stderr.trim().split('\n')[0] ?? ''}`}`, stdout: lines.join('\n') });
        },
      });
    } catch {
      if (reservationId !== undefined) lifecycle?.spawnRejected?.(reservationId);
      finish({ ok: false, reason: 'spawn_failed' });
      return;
    }
    void handle.then(async child => {
      owned = child;
      if (lifecycle && !actualExit) lifecycle.acquired?.(child, stopControlled, reservationId, confirmExit);
      if (actualExit) lifecycle?.exited?.(child.id, reservationId);
      if (settled) lifecycle?.clearProcess(child.id);
      if (lifecycle && endingReason !== undefined && !actualExit) { fail(endingReason); return; }
      if (stopWhenReady) { stop(); return; }
      if (settled || input.stdin === undefined) return;
      if (input.process.send === undefined || (!input.control && input.process.closeInput === undefined)) throw new Error('stdin_transport_unavailable');
      for (const frame of pendingControls.splice(0)) input.control?.receive(frame, child.id);
      await input.process.send(child.id, input.stdin);
      if (!input.control) await input.process.closeInput?.(child.id);
    }, () => {
      if (reservationId !== undefined) lifecycle?.spawnRejected?.(reservationId);
      finish({ ok: false, reason: endingReason ?? 'spawn_failed' });
    }).catch(() => fail('spawn_failed'));
  });
}
