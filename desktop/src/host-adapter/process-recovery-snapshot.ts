import type { RecoverableProcess, RetainedProcessOutput } from './process-service';
import { readProcessExit } from './process-exit-delivery';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function cursor(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function process(value: unknown): value is RecoverableProcess {
  return object(value) && identity(value.id) && cursor(value.pid) && value.pid > 0
    && identity(value.projectKey) && identity(value.conversationId) && object(value.identity)
    && identity(value.identity.teamRunId) && identity(value.identity.turnId);
}
function record(value: unknown): value is RetainedProcessOutput['records'][number] {
  return object(value) && cursor(value.sequence) && value.sequence > 0 && typeof value.line === 'string'
    && (value.stream === 'stdout' || value.stream === 'stderr');
}

export function recoveryProcesses(value: unknown): readonly RecoverableProcess[] {
  if (!Array.isArray(value) || !value.every(process) || new Set(value.map(row => row.id)).size !== value.length) {
    throw new Error('原生输出归属列表无效，未确认原执行退出。');
  }
  return value;
}

/** Decode transport facts before any ownership or permission state can change. */
export function retainedProcessOutput(value: unknown): RetainedProcessOutput {
  if (!object(value) || value.version !== 1 || !process(value.process)
    || !Array.isArray(value.records) || value.records.length > 512 || !value.records.every(record)
    || !cursor(value.nextSequence) || typeof value.hasMore !== 'boolean' || typeof value.gap !== 'boolean'
    || typeof value.finished !== 'boolean' || typeof value.captureComplete !== 'boolean'
    || !Array.isArray(value.answeredRequests) || !value.answeredRequests.every(identity)) {
    throw new Error('原生输出快照无效，未接管执行。');
  }
  const exit = value.exit === null ? null : readProcessExit(JSON.stringify(value.exit));
  if (value.finished ? exit === null || exit.id !== value.process.id || exit.pid !== value.process.pid : value.exit !== null) {
    throw new Error('退出回执归属异常，未确认原执行退出。');
  }
  return { version: 1, process: value.process, records: value.records, nextSequence: value.nextSequence,
    hasMore: value.hasMore, gap: value.gap, finished: value.finished, captureComplete: value.captureComplete,
    exit, answeredRequests: value.answeredRequests };
}
