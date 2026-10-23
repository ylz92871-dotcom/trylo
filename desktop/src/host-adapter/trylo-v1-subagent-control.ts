import { hostAdapter } from './index';
import type { ProcessId } from './types';
import type { SubagentInputMode } from './subagent-contract';

const live = new Set<ProcessId>();
const pending = new Map<string, { processId: ProcessId; target: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;

export function registerSubagentInputProcess(processId: ProcessId): void { live.add(processId); }
export function canSendSubagentInput(processId: ProcessId | null): boolean { return processId !== null && live.has(processId); }
export function closeSubagentInputProcess(processId: ProcessId): void {
  live.delete(processId);
  for (const [id, request] of pending) {
    if (request.processId !== processId) continue;
    clearTimeout(request.timer); pending.delete(id);
    request.reject(new Error('本轮已结束，未收到补充要求的接收确认。'));
  }
}

/** A successful pipe write is not a delivery receipt. Only the matching CLI ack settles this. */
export function sendSubagentInput(processId: ProcessId, target: string, message: string, mode?: SubagentInputMode): Promise<void> {
  if (!live.has(processId)) return Promise.reject(new Error('当前运行不支持向智能体补充要求。'));
  if ([...pending.values()].some(request => request.processId === processId && request.target === target)) {
    return Promise.reject(new Error('该智能体的上一条要求仍在等待接收确认，草稿已保留。'));
  }
  if (!message.trim() || message.trim().length > 16000 || pending.size >= 32) return Promise.reject(new Error('补充要求为空、过长或发送队列已满。'));
  const requestId = `agent-input-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('未收到接收确认，要求可能已经送达；草稿已保留。'));
    }, 20000);
    pending.set(requestId, { processId, target, resolve, reject, timer });
    void hostAdapter.process.send(processId, `${JSON.stringify({ type: 'subagent_input', requestId, target, message: message.trim(), ...(mode === undefined ? {} : { mode }) })}\n`)
      .catch(() => {
        const request = pending.get(requestId);
        if (!request) return;
        pending.delete(requestId); clearTimeout(timer);
        reject(new Error('发送通道已关闭，未收到接收确认；草稿已保留。'));
      });
  });
}

export function consumeSubagentInputResult(line: string, processId: ProcessId | null): boolean {
  let frame: unknown;
  try { frame = JSON.parse(line); } catch { return false; }
  if (typeof frame !== 'object' || frame === null || !('type' in frame) || frame.type !== 'subagent_input_result') return false;
  const result = frame as Record<string, unknown>;
  if (typeof result.requestId !== 'string' || typeof result.accepted !== 'boolean') return false;
  const request = pending.get(result.requestId);
  if (!request || processId !== request.processId) return true;
  clearTimeout(request.timer); pending.delete(result.requestId);
  if (result.accepted) request.resolve();
  else request.reject(new Error(typeof result.error === 'string' ? result.error : '要求未被接收，草稿已保留。'));
  return true;
}
