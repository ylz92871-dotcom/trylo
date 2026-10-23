import { systemTimerScheduler, type TimerHandle, type TimerScheduler } from "./scheduler.js";
import type { SubagentBudgetSnapshot, SubagentGovernance, SubagentUsage } from "./types.js";
import type { ToolOutcome } from "../ports/tools.js";

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_SUBAGENT_TOKEN_BUDGET = 32_000;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;

export class SubagentGovernanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubagentGovernanceError";
    this.code = code;
  }
}

/** Expected admission failures are tool results; unrelated defects still throw. */
export function governanceFailureOutcome(error: unknown): ToolOutcome {
  if (error instanceof SubagentGovernanceError) {
    return { outcome: "error", code: error.code, message: error.message };
  }
  throw error;
}

type ManagedSubagentResources = {
  readonly subagentId: string;
  readonly abortController: AbortController;
  timer: TimerHandle | undefined;
  usage: SubagentUsage;
  readonly tokenBudget: number;
  readonly timeoutMs: number;
  readonly timeoutMode: "wall" | "active";
  remainingMs: number;
  startedAt: number | undefined;
  readonly onTimeout: (() => void) | undefined;
  released: boolean;
};

/**
 * The tracker's own configuration. Kept apart from `SubagentGovernance` because
 * that type is also a *per-spawn* budget override, where a scheduler would be
 * meaningless — a spawn does not choose how time is measured.
 */
export type SubagentGovernanceOptions = SubagentGovernance & {
  /**
   * Where the execution timeout comes from. Injecting a hand-fired scheduler is
   * how a test proves timeout behaviour without racing real time.
   */
  readonly scheduler?: TimerScheduler | undefined;
  readonly now?: (() => number) | undefined;
};

export class SubagentGovernanceTracker {
  private readonly maxConcurrency: number;
  private readonly defaultTokenBudget: number;
  private readonly defaultTimeoutMs: number;
  private readonly scheduler: TimerScheduler;
  private readonly now: () => number;
  private activeCount = 0;
  private readonly managed = new Map<string, ManagedSubagentResources>();

  constructor(options: SubagentGovernanceOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.defaultTokenBudget = options.tokenBudget ?? DEFAULT_SUBAGENT_TOKEN_BUDGET;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    this.scheduler = options.scheduler ?? systemTimerScheduler;
    this.now = options.now ?? Date.now;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  /**
   * Attempts to allocate resources and a concurrency slot for a new subagent.
   * Throws SubagentGovernanceError if concurrency limit is exceeded.
   */
  allocate(
    subagentId: string,
    overrides?: SubagentGovernance,
    onTimeout?: () => void,
  ): {
    readonly abortController: AbortController;
    readonly tokenBudget: number;
    readonly timeoutMs: number;
  } {
    if (this.activeCount >= this.maxConcurrency) {
      throw new SubagentGovernanceError(
        "concurrency_limit_exceeded",
        `Subagent concurrency limit (${this.maxConcurrency}) exceeded. Active: ${this.activeCount}`,
      );
    }

    this.activeCount += 1;
    const abortController = new AbortController();
    const tokenBudget = overrides?.tokenBudget ?? this.defaultTokenBudget;
    const timeoutMs = overrides?.timeoutMs ?? this.defaultTimeoutMs;

    const entry: ManagedSubagentResources = {
      subagentId,
      abortController,
      timer: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      tokenBudget,
      timeoutMs,
      timeoutMode: overrides?.timeoutMode ?? "wall",
      remainingMs: timeoutMs,
      startedAt: undefined,
      onTimeout,
      released: false,
    };
    this.managed.set(subagentId, entry);
    this.arm(entry);

    return { abortController, tokenBudget, timeoutMs };
  }

  /**
   * Records token usage for a running subagent.
   * If usage exceeds the allocated tokenBudget, aborts the subagent and throws an error.
   */
  recordUsage(
    subagentId: string,
    inputTokens: number,
    outputTokens: number,
  ): SubagentUsage {
    const entry = this.managed.get(subagentId);
    if (entry === undefined) {
      return { inputTokens: 0, outputTokens: 0 };
    }

    entry.usage = {
      inputTokens: entry.usage.inputTokens + Math.max(0, inputTokens),
      outputTokens: entry.usage.outputTokens + Math.max(0, outputTokens),
    };

    const total = entry.usage.inputTokens + entry.usage.outputTokens;
    if (total > entry.tokenBudget) {
      entry.abortController.abort("token_budget_exhausted");
      throw new SubagentGovernanceError(
        "token_budget_exhausted",
        `Subagent '${subagentId}' exceeded token budget (${total} > ${entry.tokenBudget})`,
      );
    }

    return entry.usage;
  }

  getUsage(subagentId: string): SubagentUsage {
    return this.managed.get(subagentId)?.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  snapshot(subagentId: string): SubagentBudgetSnapshot | undefined {
    const entry = this.managed.get(subagentId);
    if (entry === undefined) return undefined;
    const used = entry.usage.inputTokens + entry.usage.outputTokens;
    return { tokenLimit: entry.tokenBudget, tokensUsed: used,
      tokensRemaining: Math.max(0, entry.tokenBudget - used), timeoutMs: entry.timeoutMs,
      timeRemainingMs: this.remaining(entry), timeoutMode: entry.timeoutMode };
  }

  setActivity(subagentId: string, activity: "working" | "idle"): void {
    const entry = this.managed.get(subagentId);
    if (entry === undefined || entry.timeoutMode === "wall" || entry.abortController.signal.aborted) return;
    if (activity === "idle") {
      entry.remainingMs = this.remaining(entry);
      entry.startedAt = undefined;
      entry.timer?.cancel();
      entry.timer = undefined;
    } else if (entry.startedAt === undefined) this.arm(entry);
  }

  private remaining(entry: ManagedSubagentResources): number {
    return Math.max(0, entry.remainingMs - (entry.startedAt === undefined ? 0 : Math.max(0, this.now() - entry.startedAt)));
  }

  private arm(entry: ManagedSubagentResources): void {
    if (entry.timeoutMs <= 0 || !Number.isFinite(entry.timeoutMs)) return;
    entry.startedAt = this.now();
    entry.timer = this.scheduler(entry.remainingMs, () => {
      entry.remainingMs = 0;
      entry.startedAt = undefined;
      entry.abortController.abort("subagent_timed_out");
      entry.onTimeout?.();
    });
  }

  /**
   * Releases all resources associated with a subagent.
   * Idempotent: safe to call multiple times on completion / cancellation.
   *
   * The caller decides *when* this is true. It means the run has provably
   * stopped — not that it was told to (WP-CLI-N3): a worker that ignores its
   * abort signal keeps its slot until it returns.
   */
  release(subagentId: string): void {
    const entry = this.managed.get(subagentId);
    if (entry === undefined || entry.released) {
      return;
    }

    entry.released = true;
    entry.timer?.cancel();
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.managed.delete(subagentId);
  }

  /**
   * Release all subagents and timers (for instance during host shutdown or turn cancellation).
   */
  dispose(): void {
    for (const [id, entry] of this.managed.entries()) {
      entry.timer?.cancel();
      entry.abortController.abort("governance_tracker_disposed");
      entry.released = true;
      this.managed.delete(id);
    }
    this.activeCount = 0;
  }
}
