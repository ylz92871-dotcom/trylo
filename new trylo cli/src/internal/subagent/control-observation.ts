import type { JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import { extractLatestAssistantText } from "./child-attempt.js";
import type { InteractiveChildResult } from "./interactive-worker.js";
import type { SubagentInputChannel } from "./input-channel.js";
import type { SubagentBudgetSnapshot, SubagentResult, SubagentStatus } from "./types.js";
import type { TimerHandle, TimerScheduler } from "./scheduler.js";
import { accumulatedBudget } from "./budget-snapshot.js";
import type { CompactWindow } from "../ports/compaction.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";
import type { SubagentDelivery } from "../protocol/subagent-handoff.js";

export const DEFAULT_AGENT_WAIT_MS = 10_000;
export const MAX_AGENT_WAIT_MS = 60_000;
export const MAX_MEMBER_REPORTS = 16;
type MemberReport = { readonly id: string; readonly round: number; readonly state: "progress" | "blocked" | "ready";
  readonly message: string; readonly cursor: number };
export type MemberReportHistory = { readonly reports: readonly MemberReport[]; readonly droppedThrough: number };

/** Round observations do not own or replace the runtime's terminal state. */
export class AgentRoundObservation {
  transcript: Transcript;
  promptView: CompactWindow | undefined;
  private activeRound = 1;
  private requestedRound = 1;
  private checkpointRound = 0;
  private report: InteractiveChildResult | undefined;
  private terminal: SubagentResult<InteractiveChildResult> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly reports: MemberReport[];
  private droppedReportCursor: number;
  private answerCursor: number;
  delivery: SubagentDelivery | undefined;
  cursor: number;

  constructor(private readonly channel: SubagentInputChannel, transcript: Transcript = [], cursor = 0,
    private readonly priorBudget?: SubagentBudgetSnapshot, history?: MemberReportHistory) {
    this.transcript = transcript;
    this.cursor = cursor;
    this.answerCursor = cursor;
    this.reports = [...(history?.reports ?? [])];
    this.droppedReportCursor = history?.droppedThrough ?? 0;
  }

  get reportHistory(): MemberReportHistory { return { reports: [...this.reports], droppedThrough: this.droppedReportCursor }; }

  /** Authored reports are observations, never round answers or permission decisions. */
  publishProgress(report: SubagentObservation): boolean {
    if (report.kind !== "report" || !report.text || report.reportState === undefined || this.terminal !== undefined) return false;
    if (this.reports.some(previous => previous.id === report.id && previous.round === report.round
      && previous.state === report.reportState && previous.message === report.text)) return false;
    this.cursor += 1;
    this.reports.push({ id: report.id, round: report.round, state: report.reportState, message: report.text, cursor: this.cursor });
    const removed = this.reports.length > MAX_MEMBER_REPORTS ? this.reports.shift() : undefined;
    if (removed !== undefined) this.droppedReportCursor = removed.cursor;
    this.notify();
    return true;
  }

  hasReportAfter(after = 0): boolean { return this.reports.some(report => report.cursor > after); }

  recordDelivery(delivery: SubagentDelivery): void {
    if (this.terminal !== undefined) return;
    this.delivery = delivery;
    this.cursor += 1;
    this.notify();
  }

  requestInput(): void {
    // The mailbox knows which input it has already handed to next(). The
    // worker's startRound callback may still be waiting for its microtask.
    this.requestedRound = this.channel.requestedRound;
  }

  startRound(round: number): void { this.activeRound = round; }
  get lastRound(): number { return this.activeRound; }

  checkpoint(transcript: Transcript, window?: CompactWindow): void {
    this.transcript = transcript;
    this.promptView = window;
    this.checkpointRound = this.activeRound;
  }

  publish(report: InteractiveChildResult): void {
    this.checkpoint(report.transcript, report.promptView);
    this.report = report;
    this.answerCursor = ++this.cursor;
    this.notify();
  }

  finish(result: SubagentResult<InteractiveChildResult>): void {
    this.terminal = result;
    this.answerCursor = ++this.cursor;
    if (result.output !== undefined) this.transcript = result.output.transcript;
    this.notify();
  }

  accountSettled(result: SubagentResult<InteractiveChildResult>): void {
    const changed = this.terminal?.usage.inputTokens !== result.usage.inputTokens
      || this.terminal?.usage.outputTokens !== result.usage.outputTokens;
    this.terminal = result;
    if (changed) { this.answerCursor = ++this.cursor; this.notify(); }
  }

  isReady(after?: number): boolean {
    return (after === undefined || this.answerCursor > after)
      && (this.terminal !== undefined || (this.channel.open && this.report !== undefined && this.report.rounds >= this.requestedRound));
  }

  currentBudget(budget?: SubagentBudgetSnapshot): SubagentBudgetSnapshot | undefined {
    const current = budget ?? this.terminal?.budget;
    return current === undefined ? this.priorBudget : accumulatedBudget(current, this.priorBudget);
  }

  budgetSnapshot(budget?: SubagentBudgetSnapshot): JsonObject {
    const current = this.currentBudget(budget);
    return current === undefined ? {} : { token_limit: current.tokenLimit, tokens_used: current.tokensUsed,
      tokens_remaining: current.tokensRemaining, timeout_ms: current.timeoutMs,
      active_ms_remaining: current.timeRemainingMs, timeout_mode: current.timeoutMode };
  }

  snapshot(status: SubagentStatus, after?: number, budget?: SubagentBudgetSnapshot, reportLimit = MAX_MEMBER_REPORTS): JsonObject {
    const report = this.report;
    const unread = this.reports.filter(item => item.cursor > (after ?? 0));
    const reports = unread.slice(0, reportLimit);
    const nextUnread = unread[reports.length];
    // Never acknowledge beyond the first report left for the next page.
    const cursor = nextUnread === undefined ? this.cursor : nextUnread.cursor - 1;
    // Cancellation can settle before runTurn returns a checkpoint. The carried
    // transcript then still belongs to an older round, not the cancelled work.
    const currentCheckpoint = this.checkpointRound === this.activeRound
      && this.checkpointRound >= this.requestedRound;
    const output = this.terminal === undefined
      ? (report !== undefined && report.rounds >= this.requestedRound ? report.output : "")
      : this.terminal.output?.output ?? (currentCheckpoint ? extractLatestAssistantText(this.transcript) : "");
    return {
      phase: this.terminal !== undefined ? "terminal" : this.isReady() ? "awaiting_input" : "working",
      round: this.terminal === undefined ? report?.rounds ?? 0 : this.activeRound,
      status,
      output: this.answerCursor > cursor || after !== undefined && this.answerCursor <= after ? "" : output,
      cursor,
      changed: after === undefined || cursor > after,
      reports: reports.map(item => ({ ...item })),
      has_more_reports: nextUnread !== undefined,
      ...(this.delivery === undefined ? {} : { delivery: { ...this.delivery } }),
      reports_truncated: this.droppedReportCursor > (after ?? 0),
      budget: this.budgetSnapshot(budget),
      ...(this.terminal?.error === undefined ? {} : { error: { ...this.terminal.error } }),
      usage: { ...(this.terminal?.usage ?? this.report?.usage ?? { inputTokens: 0, outputTokens: 0 }) },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** One cancellable deadline, first ready agent wins, with no orphan observers. */
export async function waitForAgentReports(input: {
  readonly ready: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly scheduler: TimerScheduler;
}): Promise<"ready" | "timeout" | "cancelled"> {
  if (input.signal.aborted) return "cancelled";
  const ready = input.ready;
  if (ready()) return "ready";
  if (input.timeoutMs === 0) return "timeout";
  let settle!: (outcome: "ready" | "timeout" | "cancelled") => void;
  const answer = new Promise<"ready" | "timeout" | "cancelled">(resolve => { settle = resolve; });
  const changed = (): void => { if (ready()) settle("ready"); };
  const detach = input.subscribe(changed);
  const cancel = (): void => { settle("cancelled"); };
  input.signal.addEventListener("abort", cancel, { once: true });
  let timer: TimerHandle | undefined;
  try {
    timer = input.scheduler(input.timeoutMs, () => { settle("timeout"); });
    if (input.signal.aborted) cancel();
    changed();
    return await answer;
  } finally {
    timer?.cancel();
    input.signal.removeEventListener("abort", cancel);
    detach();
  }
}
