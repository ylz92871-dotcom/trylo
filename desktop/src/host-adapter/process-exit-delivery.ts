import type { ProcessExitInfo } from './process-service';

type ExitDelivery = { readonly kind: 'listening' } | { readonly kind: 'delivered' }
  | { readonly kind: 'pending'; readonly info: ProcessExitInfo; readonly timer: ReturnType<typeof setTimeout> };

function integerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** Validate lifecycle payload fields at the ProcessService boundary. */
export function readProcessExit(raw: string): ProcessExitInfo | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('id' in value) || typeof value.id !== 'string' || value.id.length === 0
    || !('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 0
    || !('code' in value) || !integerOrNull(value.code) || !('signal' in value) || !integerOrNull(value.signal)) return null;
  const outputComplete = 'outputComplete' in value ? value.outputComplete : undefined;
  const stderrLines = 'stderrLines' in value ? value.stderrLines : undefined;
  if (outputComplete !== undefined && typeof outputComplete !== 'boolean') return null;
  if (stderrLines !== undefined && (typeof stderrLines !== 'number'
    || !Number.isSafeInteger(stderrLines) || stderrLines < 0)) return null;
  return { id: value.id, pid: value.pid, code: value.code, signal: value.signal,
    ...(typeof outputComplete === 'boolean' ? { outputComplete } : {}),
    ...(typeof stderrLines === 'number' ? { stderrLines } : {}) };
}

/** stdout and stderr have separate IPC queues; a real exit waits for counted stderr. */
export function createProcessExitDelivery(onExit: (info: ProcessExitInfo) => void, timeoutMs = 500): {
  acceptExit(info: ProcessExitInfo): void;
  receivedStderr(): void;
} {
  let state: ExitDelivery = { kind: 'listening' };
  let stderrReceived = 0;
  const deliver = (info: ProcessExitInfo): void => {
    if (state.kind === 'delivered') return;
    if (state.kind === 'pending') clearTimeout(state.timer);
    state = { kind: 'delivered' };
    onExit(info);
  };
  return {
    acceptExit(info) {
      if (state.kind !== 'listening') return;
      if (stderrReceived >= (info.stderrLines ?? 0)) { deliver(info); return; }
      const timer = setTimeout(() => {
        if (state.kind === 'pending') deliver({ ...state.info, outputComplete: false });
      }, timeoutMs);
      state = { kind: 'pending', info, timer };
    },
    receivedStderr() {
      stderrReceived += 1;
      if (state.kind === 'pending' && stderrReceived >= (state.info.stderrLines ?? 0)) deliver(state.info);
    },
  };
}
