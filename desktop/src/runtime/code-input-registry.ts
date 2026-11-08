import type { ControlFrame, ControlInputFrame } from '../host-adapter/control-protocol';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { InputRequestAnswer } from '../host-adapter/input-request';

type Pending = { frame: ControlInputFrame; processId: string; emit: (events: readonly LoopEvent[]) => void };
/** Questions are input, never approvals. Every response stays bound to its originating process. */
export class CodeInputRegistry {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly send: (processId: string, line: string) => Promise<void>) {}
  handle(frame: ControlFrame, processId: string, emit: Pending['emit']): boolean {
    if (frame.kind === 'cancel') {
      const entry = this.pending.get(frame.requestId);
      if (!entry || entry.processId !== processId) return false;
      this.settle(entry, 'dismissed'); return true;
    }
    if (frame.kind !== 'input') return false;
    if (this.pending.has(frame.requestId)) return true;
    this.pending.set(frame.requestId, { frame, processId, emit });
    emit([{ type: 'input_request', seq: 0, ts: Date.now(), requestId: frame.requestId,
      questions: frame.questions, status: 'pending' }]);
    return true;
  }
  has(requestId: string): boolean { return this.pending.has(requestId); }
  async respond(requestId: string, status: 'submitted' | 'dismissed', answers?: Record<string, InputRequestAnswer>): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const values: Record<string, string> = Object.create(null);
    if (status === 'submitted') {
      for (const question of entry.frame.questions) {
        const answer = answers?.[question.id];
        const value = [...(answer?.optionLabels ?? (answer?.optionLabel ? [answer.optionLabel] : [])),
          ...(answer?.otherText?.trim() ? [answer.otherText.trim()] : [])].join(', ');
        if (!value) return false;
        values[question.id] = value;
      }
    }
    try {
      await this.send(entry.processId, JSON.stringify({ type: 'control_response', response: {
        subtype: 'success', request_id: requestId, response: { status, answers: values },
      } }) + '\n');
    } catch { return false; } // Keep the question pending so the user can retry.
    if (this.pending.get(requestId) !== entry) return false;
    this.settle(entry, status, answers); return true;
  }
  clearProcess(processId: string): void {
    for (const entry of [...this.pending.values()]) if (entry.processId === processId) this.settle(entry, 'dismissed');
  }
  private settle(entry: Pending, status: 'submitted' | 'dismissed', answers?: Record<string, InputRequestAnswer>): void {
    this.pending.delete(entry.frame.requestId);
    entry.emit([{ type: 'input_request', seq: 0, ts: Date.now(), requestId: entry.frame.requestId,
      questions: entry.frame.questions, status, ...(answers ? { answers } : {}) }]);
  }
}
