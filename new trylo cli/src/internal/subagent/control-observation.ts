import type { JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import { extractLatestAssistantText } from "./child-attempt.js";
import type { InteractiveChildResult } from "./interactive-worker.js";
import type { SubagentInputChannel } from "./input-channel.js";
import type { SubagentResult, SubagentStatus } from "./types.js";
import type { TimerHandle, TimerScheduler } from "./scheduler.js";

export const DEFAULT_AGENT_WAIT_MS = 10_000;
export const MAX_AGENT_WAIT_MS = 60_000;

/** Round observations do not own or replace the runtime's terminal state. */
export class AgentRoundObservation {
  transcript: Transcript;
  private activeRound = 1;
  private requestedRound = 1;
  private checkpointRound = 0;
  private report: InteractiveChildResult | undefined;
  private terminal: SubagentResult<InteractiveChildResult> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly channel: SubagentInputChannel, transcript: Transcript = []) {
    this.transcript = transcript;
  }

  requestInput(interrupt: boolean): void {
    this.requestedRound = interrupt ? this.activeRound + 1 : this.requestedRound + 1;
  }

  startRound(round: number): void { this.activeRound = round; }

  checkpoint(transcript: Transcript): void {
    this.transcript = transcript;
    this.checkpointRound = this.activeRound;
  }

  publish(report: InteractiveChildResult): void {
    this.checkpoint(report.transcript);
    this.report = report;
    this.notify();
  }

  finish(result: SubagentResult<InteractiveChildResult>): void {
    this.terminal = result;
    if (result.output !== undefined) this.transcript = result.output.transcript;
    this.notify();
  }

  isReady(): boolean {
    return this.terminal !== undefined || (this.channel.open && this.report !== undefined && this.report.rounds >= this.requestedRound);
  }

  snapshot(status: SubagentStatus): JsonObject {
    const report = this.report;
    // Cancellation can settle before runTurn returns a checkpoint. The carried
    // transcript then still belongs to an older round, not the cancelled work.
    const currentCheckpoint = this.checkpointRound === this.activeRound
      && this.checkpointRound >= this.requestedRound;
    const output = this.terminal === undefined
      ? report?.output ?? ""
      : this.terminal.output?.output ?? (currentCheckpoint ? extractLatestAssistantText(this.transcript) : "");
    return {
      phase: this.terminal !== undefined ? "terminal" : this.isReady() ? "awaiting_input" : "working",
      round: this.terminal === undefined ? report?.rounds ?? 0 : this.activeRound,
      status,
      output,
      ...(this.terminal?.error === undefined ? {} : { error: { ...this.terminal.error } }),
      ...(this.terminal?.usage === undefined ? {} : { usage: { ...this.terminal.usage } }),
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
  readonly agents: ReadonlyArray<AgentRoundObservation>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly scheduler: TimerScheduler;
}): Promise<"ready" | "timeout" | "cancelled"> {
  if (input.signal.aborted) return "cancelled";
  if (input.agents.some(agent => agent.isReady())) return "ready";
  if (input.timeoutMs === 0) return "timeout";
  let settle!: (outcome: "ready" | "timeout" | "cancelled") => void;
  const answer = new Promise<"ready" | "timeout" | "cancelled">(resolve => { settle = resolve; });
  const changed = (): void => { if (input.agents.some(agent => agent.isReady())) settle("ready"); };
  const detach = input.agents.map(agent => agent.subscribe(changed));
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
    for (const unsubscribe of detach) unsubscribe();
  }
}
