import type { JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import { extractLatestAssistantText } from "./child-attempt.js";
import type { InteractiveChildResult } from "./interactive-worker.js";
import type { SubagentInputChannel } from "./input-channel.js";
import type { SubagentBudgetSnapshot, SubagentResult, SubagentStatus } from "./types.js";
import type { TimerHandle, TimerScheduler } from "./scheduler.js";
import { accumulatedBudget } from "./budget-snapshot.js";
import type { CompactWindow } from "../ports/compaction.js";

export const DEFAULT_AGENT_WAIT_MS = 10_000;
export const MAX_AGENT_WAIT_MS = 60_000;

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
  cursor: number;

  constructor(private readonly channel: SubagentInputChannel, transcript: Transcript = [], cursor = 0,
    private readonly priorBudget?: SubagentBudgetSnapshot) {
    this.transcript = transcript;
    this.cursor = cursor;
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
    this.cursor += 1;
    this.notify();
  }

  finish(result: SubagentResult<InteractiveChildResult>): void {
    this.terminal = result;
    this.cursor += 1;
    if (result.output !== undefined) this.transcript = result.output.transcript;
    this.notify();
  }

  accountSettled(result: SubagentResult<InteractiveChildResult>): void {
    const changed = this.terminal?.usage.inputTokens !== result.usage.inputTokens
      || this.terminal?.usage.outputTokens !== result.usage.outputTokens;
    this.terminal = result;
    if (changed) { this.cursor += 1; this.notify(); }
  }

  isReady(after?: number): boolean {
    return (after === undefined || this.cursor > after)
      && (this.terminal !== undefined || (this.channel.open && this.report !== undefined && this.report.rounds >= this.requestedRound));
  }

  currentBudget(budget?: SubagentBudgetSnapshot): SubagentBudgetSnapshot | undefined {
    const current = budget ?? this.terminal?.budget;
    return accumulatedBudget(current, this.priorBudget);
  }

  budgetSnapshot(budget?: SubagentBudgetSnapshot): JsonObject {
    const current = this.currentBudget(budget);
    return current === undefined ? {} : { token_limit: current.tokenLimit, tokens_used: current.tokensUsed,
      tokens_remaining: current.tokensRemaining, timeout_ms: current.timeoutMs,
      active_ms_remaining: current.timeRemainingMs, timeout_mode: current.timeoutMode };
  }

  snapshot(status: SubagentStatus, after?: number, budget?: SubagentBudgetSnapshot): JsonObject {
    const report = this.report;
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
      output: after !== undefined && this.cursor <= after ? "" : output,
      cursor: this.cursor,
      changed: after === undefined || this.cursor > after,
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
