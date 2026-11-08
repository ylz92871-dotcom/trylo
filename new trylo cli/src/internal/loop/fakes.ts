import { createCompactionService } from "../compaction/service.js";
import { EMPTY_PROFILE, type ProfilePort } from "../contract/profile.js";
import type { CompactRequest, CompactionPort } from "../ports/compaction.js";
import {
  decision,
  type PermissionDecision,
  type PermissionPort,
  type PermissionResolution,
} from "../ports/permission.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import type { ToolBinding, ToolOutcome, ToolPort } from "../ports/tools.js";
import type { CompactionWiring } from "./compact-boundary.js";

export type FakeProviderScript = ReadonlyArray<ReadonlyArray<ProviderEvent>>;

export function createFakeProvider(script: FakeProviderScript): ProviderPort {
  let index = 0;
  return {
    async *stream(_request, signal) {
      const events = script[index] ?? [];

      index += 1;

      for (const event of events) {
        if (signal.aborted) {
          yield { type: "cancel_ack" };
          return;
        }
        yield event;
      }
    },
  };
}

export function echoBinding(overrides: Partial<ToolBinding> = {}): ToolBinding {
  return {
    name: "echo",
    description: "Echo a value back. Read-only test tool.",
    sideEffect: "read_only",
    parameters: { type: "object" },
    needsApproval: true,
    timeoutMs: 1_000,
    outputLimits: { maxBytes: 65_536, maxLines: 200 },
    ...overrides,
  };
}

export function toolResult(value: JsonObject, output = JSON.stringify(value)): ToolOutcome {
  return { outcome: "result", value, output, truncated: false };
}

export function createFakeTools(
  plan: ReadonlyArray<ToolOutcome>,
  bindings: ReadonlyArray<ToolBinding> = [echoBinding()],
): ToolPort {
  let index = 0;
  return {
    snapshot() {
      return bindings;
    },
    async execute(_call, signal) {
      if (signal.aborted) {
        return { outcome: "cancelled" };
      }
      const next = plan[index];
      index += 1;
      return next ?? toolResult({ ok: true });
    },
    async cancel() {
      return;
    },
  };
}

export function createFakePermission(
  policy: PermissionResolution,
  scope: "once" | "session" = "once",
): PermissionPort {
  return {
    async request(action) {
      return { ticketId: `tkt-${action.toolCallId}`, toolCallId: action.toolCallId };
    },
    async awaitDecision(_ticketId): Promise<PermissionDecision> {
      return decision(policy, scope);
    },
  };
}

export function emptyProfileLoader(): ProfilePort {
  return {
    async load() {
      return EMPTY_PROFILE;
    },
  };
}

export type FakeCompactionOptions = {
  /** What `estimatePromptTokens` reports for every candidate request. */
  readonly estimatedPromptTokens?: number;
  /**
   * What the estimate reports once a window has been stored — the shape of a
   * real summarizer, whose view shrinks when history is replaced. Absent, the
   * estimate is the same constant before and after, which is the degenerate
   * "the summary never helped" case.
   */
  readonly estimatedAfterCompactionTokens?: number;
  /** What `summarize` returns. An unsafe string drives the refusal path. */
  readonly summary?: string;
};

export type FakeCompaction = {
  readonly wiring: CompactionWiring;
  /** Every request the port was asked to author a window for, in order. */
  readonly compactRequests: CompactRequest[];
  /** The live items handed to `summarize`, in order. */
  readonly summarizeInputs: Array<readonly TranscriptItem[]>;
};

/**
 * The shipping compaction service behind a recording boundary.
 *
 * Deliberately not a fake policy: the wiring contract has to hold against the
 * real threshold, the real read-time filter and the real summary red-line, or a
 * green test here would only prove that the double agrees with itself.
 */
export function createFakeCompaction(options: FakeCompactionOptions = {}): FakeCompaction {
  const service = createCompactionService();
  const compactRequests: CompactRequest[] = [];
  const summarizeInputs: Array<readonly TranscriptItem[]> = [];
  const estimated = options.estimatedPromptTokens ?? 0;
  const afterCompaction = options.estimatedAfterCompactionTokens ?? estimated;
  const summary = options.summary ?? "SUMMARY-MARKER";
  let stored = false;
  const port: CompactionPort = {
    ...service,
    compact(request) {
      compactRequests.push(request);
      const outcome = service.compact(request);

      // A stored window is the fact the estimate switches on: the view the
      // next request carries is the one the window replaced history for.
      if (outcome.ok) {
        stored = true;
      }

      return outcome;
    },
  };

  return {
    compactRequests,
    summarizeInputs,
    wiring: {
      port,
      // These scenarios model growth after the first response. A fresh short
      // input is below the ceiling; use real estimates to test oversized input.
      estimatePromptTokens: messages => stored ? afterCompaction
        : messages.some(message => message.role === "assistant" || message.role === "tool") ? estimated : 0,
      summarize(items) {
        summarizeInputs.push(items);
        return summary;
      },
      // A fixed stamp, not a clock: a test that reads the wall clock would pass
      // or fail on when it ran, and the draft only needs *a* time here.
      now: () => "1970-01-01T00:00:00.000Z",
    },
  };
}
