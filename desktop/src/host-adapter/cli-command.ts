import type { ProcessService, ProcessHandle } from './process-service';
import { cliSpawnCommand } from './cli-runtime-path';
import type { FilePath } from './types';

export type CliCommandInput = {
  readonly process: Pick<ProcessService, 'spawn' | 'stop'> & Partial<Pick<ProcessService, 'send' | 'closeInput'>>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly timeoutMs?: number;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly signal?: AbortSignal;
};
export type CliCommandResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string; readonly stdout?: string };

/** Shared one-shot transport. Domain consumers decode their own versioned CLI replies. */
export async function runCliCommand(input: CliCommandInput): Promise<CliCommandResult> {
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };
  const { command, prefix } = cliSpawnCommand(input.cliPath, input.nodeProgram);
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return { ok: false, reason: 'invalid_timeout' };
  return new Promise(resolve => {
    let settled = false, bytes = 0, stderr = '', stopWhenReady = false;
    let handle: Promise<ProcessHandle> | undefined, owned: ProcessHandle | undefined, stopped = false;
    const lines: string[] = [];
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
      resolve(result);
    };
    const abort = (): void => { stop(); finish({ ok: false, reason: 'cancelled' }); };
    const timer = setTimeout(() => { stop(); finish({ ok: false, reason: 'timeout' }); }, timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      handle = input.process.spawn({ command, args: [...prefix, ...input.args], label: `trylo-${input.args[0] ?? 'query'}-${input.args[1] ?? 'command'}`, cwd: input.cwd,
        onOutput: line => {
          if (settled) return;
          bytes += line.length + 1;
          if (bytes > 1_048_576) { stop(); finish({ ok: false, reason: 'output_limit' }); return; }
          lines.push(line);
        },
        onStderr: line => { if (!settled) stderr = `${stderr}${line}\n`.slice(0, 8_192); },
        onExit: info => {
          if (info.outputComplete === false) { finish({ ok: false, reason: 'incomplete_output' }); return; }
          finish(info.code === 0 ? { ok: true, stdout: lines.join('\n') }
            : { ok: false, reason: `exit_${String(info.code ?? 'signal')}${stderr.trim() === '' ? '' : `:${stderr.trim().split('\n')[0] ?? ''}`}`, stdout: lines.join('\n') });
        },
      });
    } catch {
      finish({ ok: false, reason: 'spawn_failed' });
      return;
    }
    void handle.then(async child => {
      owned = child;
      if (stopWhenReady) { stop(); return; }
      if (settled || input.stdin === undefined) return;
      if (input.process.send === undefined || input.process.closeInput === undefined) throw new Error('stdin_transport_unavailable');
      await input.process.send(child.id, input.stdin);
      await input.process.closeInput(child.id);
    }).catch(() => { stop(); finish({ ok: false, reason: 'spawn_failed' }); });
  });
}
