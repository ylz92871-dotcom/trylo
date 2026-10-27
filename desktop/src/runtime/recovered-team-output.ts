import type { ProcessService, RecoverableProcess, RetainedProcessOutput } from '../host-adapter/process-service';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { ControlFrame } from '../host-adapter/control-protocol';
import { TryloV1EventAdapter } from '../host-adapter/trylo-v1-event-adapter';
import { readV1Control } from '../host-adapter/trylo-v1-control';
import { closeSubagentInputProcess, consumeSubagentInputResult, registerSubagentInputProcess } from '../host-adapter/trylo-v1-subagent-control';
import type { CodeRunViewState } from './runtime-types';
import { registeredProcessIds } from '../host-adapter/process-snapshot';
import { recoveryProcesses, retainedProcessOutput } from '../host-adapter/process-recovery-snapshot';

export interface TeamOutputRecovery {
  readonly process: RecoverableProcess;
  readonly events: readonly LoopEvent[];
  readonly live: boolean;
  readonly sessionId: string | null;
  acknowledge(): void;
}
export class IncompleteTeamOutputError extends Error {
  constructor(readonly confirmedExited: boolean, readonly cancelled = false) {
    super(confirmedExited ? '原执行已退出，但保留输出不完整；保留先前已核实结果。'
      : '保留的输出存在缺口，未将不完整记录当作执行结果。请先停止旧执行。');
  }
}
interface Connection {
  readonly process: RecoverableProcess;
  readonly adapter: TryloV1EventAdapter;
  readonly controls: Map<string, ControlFrame>;
  readonly shown: Set<string>;
  cursor: number;
  pending: { readonly event: LoopEvent }[];
  stderr: string[];
  live: boolean;
  ready: boolean;
  failed: boolean;
  finalized: boolean;
  cancelled: boolean;
}

/** Stream snapshots replace earlier snapshots, rather than retaining every
 * growing fullText copy during a large catch-up or a slow persistence write. */
function appendEvents(entry: Connection, events: readonly LoopEvent[]): void {
  for (const event of events) {
    if ((event.type === 'text' || event.type === 'thinking') && event.blockId !== undefined) {
      const index = entry.pending.findIndex(({ event: previous }) => previous.type === event.type
        && (previous.type === 'text' || previous.type === 'thinking') && previous.blockId === event.blockId);
      if (index >= 0) { entry.pending[index] = { event }; continue; }
    }
    entry.pending.push({ event });
  }
}

async function nativeRead<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('原生输出读取超时，请重试。')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
function sameOwner(a: RecoverableProcess, b: RecoverableProcess): boolean {
  return a.id === b.id && a.pid === b.pid && a.projectKey === b.projectKey && a.conversationId === b.conversationId
    && a.identity.teamRunId === b.identity.teamRunId && a.identity.turnId === b.identity.turnId;
}

/** Rebuilds interpretation only. Neither old prompts nor old decisions are sent. */
export class RecoveredTeamOutput {
  private readonly connections = new Map<string, Connection>();
  private readonly reads = new Map<string, Promise<TeamOutputRecovery | null>>();
  constructor(private readonly port: () => ProcessService,
    private readonly control: (frame: ControlFrame, processId: string, projectKey: string, conversationId: string) => void,
    private readonly exited: (processId: string) => void,
    private readonly changed: () => void) {}

  read(projectKey: string, conversationId: string, teamRunId: string): Promise<TeamOutputRecovery | null> {
    const key = JSON.stringify([projectKey, conversationId, teamRunId]);
    const existing = this.reads.get(key);
    if (existing) return existing;
    const pending = this.readOnce(projectKey, conversationId, teamRunId).catch(error => {
      // Lookup/decoding can fail before readOnce acquires an entry. Revoke old
      // input capabilities as well; uncertain IO never releases ownership.
      for (const entry of this.connections.values()) if (entry.live && entry.ready && entry.process.projectKey === projectKey
        && entry.process.conversationId === conversationId && entry.process.identity.teamRunId === teamRunId) this.disconnect(entry);
      throw error;
    }).finally(() => {
      if (this.reads.get(key) === pending) this.reads.delete(key);
    });
    this.reads.set(key, pending);
    return pending;
  }

  private async readOnce(projectKey: string, conversationId: string, teamRunId: string): Promise<TeamOutputRecovery | null> {
    const port = this.port();
    if (!port.recoveryList || !port.readOutput) return null;
    const candidates = recoveryProcesses(await nativeRead(() => port.recoveryList!())).filter(process => process.projectKey === projectKey
      && process.conversationId === conversationId && process.identity.teamRunId === teamRunId);
    if (candidates.length === 0) return this.readExpired(port, projectKey, conversationId, teamRunId);
    if (candidates.length !== 1) throw new Error('同一团队存在多个执行记录，未自动接管。请先停止旧执行。');
    const process = candidates[0]!;
    let entry = this.connections.get(process.id);
    if (!entry) {
      entry = { process, adapter: new TryloV1EventAdapter(), controls: new Map(), shown: new Set(), cursor: 0,
        pending: [], stderr: [], live: true, ready: false, failed: false, finalized: false, cancelled: false };
      this.connections.set(process.id, entry);
    }
    if (!sameOwner(entry.process, process)) throw new Error('执行归属发生变化，未接管输出。');
    if (entry.finalized && !entry.live) return this.receipt(entry);
    try {
      let page: RetainedProcessOutput;
      for (let count = 0; ; count += 1) {
        if (count >= 32) throw new Error('输出读取分页超过上限。');
        page = retainedProcessOutput(await nativeRead(() => port.readOutput!(process.id, entry!.cursor)));
        if (page.version !== 1 || !sameOwner(process, page.process)) throw new Error('输出归属或版本异常，未接管执行。');
        if (entry.failed || page.gap || !page.captureComplete) {
          entry.failed = true;
          const exited = page.finished && page.exit?.id === process.id && page.exit.pid === process.pid;
          if (exited) entry.live = false;
          throw new IncompleteTeamOutputError(exited, entry.cancelled);
        }
        let expected = entry.cursor;
        for (const record of page.records) {
          if (record.sequence !== expected + 1 || typeof record.line !== 'string'
            || (record.stream !== 'stdout' && record.stream !== 'stderr')) {
            entry.failed = true; throw new Error('输出序号或通道异常，未接管执行。');
          }
          expected = record.sequence;
        }
        if (page.nextSequence !== expected || page.hasMore && page.records.length === 0) {
          entry.failed = true; throw new Error('输出游标异常，未接管执行。');
        }
        for (const record of page.records) {
          if (record.stream === 'stderr') { entry.stderr = [...entry.stderr, record.line].slice(-20); continue; }
          if (consumeSubagentInputResult(record.line, process.id)) continue;
          const frame = readV1Control(record.line);
          if (frame) {
            if (frame.kind === 'cancel') {
              entry.controls.delete(frame.requestId);
              if (entry.shown.delete(frame.requestId)) this.control(frame, process.id, projectKey, conversationId);
            } else entry.controls.set(frame.requestId, frame);
          } else appendEvents(entry, entry.adapter.feed(record.line));
        }
        for (const answered of page.answeredRequests) {
          entry.controls.delete(answered);
          if (entry.shown.delete(answered)) this.control({ kind: 'cancel', requestId: answered }, process.id, projectKey, conversationId);
        }
        entry.cursor = page.nextSequence;
        if (!page.hasMore) break;
      }
      entry.live = !page.finished;
      if (page.finished && !entry.finalized) {
        if (!page.exit || page.exit.id !== process.id || page.exit.pid !== process.pid) throw new Error('退出回执归属异常。');
        this.finalize(entry, page.exit.code);
      }
      entry.ready = true;
      if (entry.live && !entry.adapter.hasTerminal) {
        registerSubagentInputProcess(process.id);
        for (const frame of entry.controls.values()) if (!entry.shown.has(frame.requestId)) {
          entry.shown.add(frame.requestId); this.control(frame, process.id, projectKey, conversationId);
        }
      } else {
        closeSubagentInputProcess(process.id); this.exited(process.id); entry.controls.clear();
      }
      this.changed();
      return this.receipt(entry);
    } catch (error) {
      this.disconnect(entry);
      throw error;
    }
  }

  private disconnect(entry: Connection): void {
    entry.ready = false;
    closeSubagentInputProcess(entry.process.id); this.exited(entry.process.id);
    entry.shown.clear(); this.changed();
  }

  private finalize(entry: Connection, exitCode: number | null): void {
    if (entry.finalized) return;
    if (!entry.adapter.hasTerminal && entry.adapter.rejectedLines().length > 0) {
      appendEvents(entry, [entry.adapter.warn('protocol_rejected', entry.adapter.describeRejections())]);
    }
    appendEvents(entry, entry.adapter.finalizeExit({ exitCode, stderr: entry.stderr, cancelled: entry.cancelled }));
    entry.finalized = true;
  }

  private receipt(entry: Connection): TeamOutputRecovery {
    const committed = entry.pending.slice();
    const acknowledgedEntries = new Set(committed);
    let acknowledged = false;
    return { process: entry.process, events: committed.map(item => item.event), live: entry.live,
      sessionId: entry.adapter.summary().sessionId, acknowledge: () => {
        if (acknowledged) return;
        acknowledged = true; entry.pending = entry.pending.filter(item => !acknowledgedEntries.has(item));
      } };
  }

  private async readExpired(port: ProcessService, projectKey: string, conversationId: string, teamRunId: string): Promise<TeamOutputRecovery | null> {
    const entries = [...this.connections.values()].filter(entry => entry.process.projectKey === projectKey
      && entry.process.conversationId === conversationId && entry.process.identity.teamRunId === teamRunId);
    const active = entries.filter(entry => entry.live);
    if (active.length > 1) throw new Error('同一团队仍有多个旧执行，未确认退出。');
    const entry = active[0] ?? entries.at(-1);
    if (!entry) return null;
    if (entry.finalized && !entry.live) return this.receipt(entry);
    try {
      const ids = registeredProcessIds(await nativeRead(() => port.list()));
      if (ids.has(entry.process.id)) throw new Error('保留输出暂不可用，原执行仍在运行；请等待重接或重试停止。');
      entry.live = false;
      if (entry.failed) throw new IncompleteTeamOutputError(true, entry.cancelled);
      appendEvents(entry, [entry.adapter.warn('process_output_incomplete', '原执行已退出，但保留输出已过期；仅保留已核实的结果。')]);
      this.finalize(entry, null);
      this.disconnect(entry);
      return this.receipt(entry);
    } catch (error) { this.disconnect(entry); throw error; }
  }

  view(projectKey: string, conversationId: string): CodeRunViewState | null {
    const entry = [...this.connections.values()].find(value => value.live && value.process.projectKey === projectKey
      && value.process.conversationId === conversationId);
    if (!entry) return null;
    return { running: true, sendable: false, error: !entry.ready, activeProcessId: entry.ready ? entry.process.id : null,
      runId: entry.process.identity.turnId, pid: entry.process.pid, bindingState: 'busy' };
  }

  activeProcess(projectKey: string, conversationId: string): string | null {
    return [...this.connections.values()].find(entry => entry.ready && entry.live && !entry.adapter.hasTerminal
      && entry.process.projectKey === projectKey && entry.process.conversationId === conversationId)?.process.id ?? null;
  }

  enqueue(processId: string, events: readonly LoopEvent[]): void {
    const entry = this.connections.get(processId);
    if (entry) appendEvents(entry, events);
  }

  requestStop(projectKey?: string, conversationId?: string): void {
    for (const entry of this.connections.values()) if (entry.live
      && (projectKey === undefined || entry.process.projectKey === projectKey)
      && (conversationId === undefined || entry.process.conversationId === conversationId)) entry.cancelled = true;
  }

  /** Consume the retained tail before fallback cancellation can settle history. */
  async confirmStopped(projectKey?: string, conversationId?: string): Promise<readonly TeamOutputRecovery[]> {
    const receipts: TeamOutputRecovery[] = [];
    for (const entry of this.connections.values()) {
      if (!entry.live && entry.pending.length === 0 || projectKey !== undefined && entry.process.projectKey !== projectKey
        || conversationId !== undefined && entry.process.conversationId !== conversationId) continue;
      try {
        const receipt = await this.read(entry.process.projectKey, entry.process.conversationId, entry.process.identity.teamRunId);
        if (!receipt || receipt.live) throw new Error('原执行尾部输出仍在核对，请稍后重试停止。');
        receipts.push(receipt);
      } catch (error) {
        // Missing bytes still belong to history reconciliation, but confirmed
        // process absence is enough to release this cancellation's native hold.
        if (!(error instanceof IncompleteTeamOutputError && error.confirmedExited)) throw error;
      }
    }
    return receipts;
  }
}
