import type { ProviderMessage } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { SubagentRoutingDecision, SubagentRoutingPort, SubagentRoutingReceipt } from "../ports/subagent-routing.js";
import { SUBAGENT_ROUTING_PARENT_BYTES } from "../ports/subagent-routing.js";
import type { SubagentResult } from "./types.js";
import { completedParentContext } from "./fork-context.js";
import { boundedJsonBytes } from "../protocol/bounded-json-bytes.js";
import { observeOptional } from "./optional-observer.js";
import { systemTimerScheduler, type TimerScheduler } from "./scheduler.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const hasParentContent = (messages: readonly ProviderMessage[]) => messages.some(message => message.role !== "system"
  && (message.content.length > 0 || (message.attachments?.length ?? 0) > 0 || (message.imageReferences?.length ?? 0) > 0));

function isDecision(value: unknown): value is SubagentRoutingDecision {
  return record(value) && only(value, ["path", "reason", "versionId", "candidateIds"])
    && (value.path === "independent" || value.path === "fork") && text(value.reason)
    && (value.versionId === undefined || text(value.versionId)) && Array.isArray(value.candidateIds)
    && value.candidateIds.length > 0 && value.candidateIds.length <= 2
    && value.candidateIds.every(item => item === "independent" || item === "fork")
    && new Set(value.candidateIds).size === value.candidateIds.length;
}

/** Additive v1 checkpoint field; old checkpoints simply have no routing receipt. */
export function isSubagentRoutingReceipt(value: unknown): value is SubagentRoutingReceipt {
  if (!record(value) || !only(value, ["selectionExecutionId", "decision", "actualPath", "conditions"])
    || !text(value.selectionExecutionId) || !isDecision(value.decision) || !record(value.conditions)) return false;

  const conditions = value.conditions;

  return only(conditions, ["parentAvailable", "parentMessageCount", "parentBytes", "parentContextBasis", "messageBytes"])
    && typeof conditions.parentAvailable === "boolean" && count(conditions.parentMessageCount)
    && (conditions.parentBytes === undefined || count(conditions.parentBytes)) && count(conditions.messageBytes)
    && (conditions.parentContextBasis === undefined || conditions.parentContextBasis === "input"
      && value.actualPath === "independent" && value.decision.reason === "routing_context_capacity")
    && value.decision.candidateIds.length === (conditions.parentAvailable ? 2 : 1)
    && value.decision.candidateIds.includes("independent")
    && value.actualPath === value.decision.path && value.decision.candidateIds.includes(value.decision.path)
    && (value.actualPath !== "fork" || conditions.parentAvailable);
}

export async function chooseSubagentRouting(port: SubagentRoutingPort, input: {
  readonly executionId: string; readonly message: string; readonly parentMessages: readonly ProviderMessage[];
  readonly explicitFork?: boolean; readonly signal: AbortSignal;
  readonly inheritedProfile?: boolean;
}, scheduler: TimerScheduler = systemTimerScheduler): Promise<{ readonly receipt: SubagentRoutingReceipt; readonly diagnostics: string[];
  readonly forkMessages?: readonly ProviderMessage[] }> {
  input.signal.throwIfAborted();
  const parentBytes = boundedJsonBytes(input.parentMessages, SUBAGENT_ROUTING_PARENT_BYTES);
  if (input.explicitFork === undefined && parentBytes === undefined) {
    // No serialized string, clone, completed-pair indexes or copied parent list on this branch.
    const parentAvailable = hasParentContent(input.parentMessages);
    return { receipt: { selectionExecutionId: input.executionId,
      decision: { path: "independent", reason: "routing_context_capacity", candidateIds: parentAvailable ? ["independent", "fork"] : ["independent"] },
      actualPath: "independent", conditions: { parentAvailable, parentMessageCount: input.parentMessages.length,
        parentContextBasis: "input", messageBytes: Buffer.byteLength(input.message) } }, diagnostics: ["routing_context_capacity"] };
  }

  const messages = completedParentContext(structuredClone(input.parentMessages));
  const parentAvailable = hasParentContent(messages);
  const candidates = parentAvailable ? ["independent", "fork"] : ["independent"];
  const diagnostics: string[] = [];
  let decision: SubagentRoutingDecision = { path: "independent", reason: "default_independent", candidateIds: candidates };

  if (input.explicitFork !== undefined) {
    decision = { path: input.explicitFork && parentAvailable ? "fork" : "independent", reason: input.explicitFork && !parentAvailable
      ? "parent_context_unavailable" : "explicit_fork_context", candidateIds: candidates };
  } else {
    const selected = await observeOptional(() => port.choose({ ...input, parentMessages: structuredClone(messages) }), scheduler, input.signal);
    if (selected.kind === "value") {
      const proposed = selected.value;
      if (!isDecision(proposed) || proposed.candidateIds.length !== candidates.length
        || proposed.candidateIds.some(id => !candidates.includes(id)) || !candidates.includes(proposed.path)) {
        diagnostics.push("routing_decision_invalid");
      } else decision = { ...proposed, candidateIds: candidates };
    } else {
      input.signal.throwIfAborted();
      diagnostics.push("routing_choose_failed");
    }
  }

  input.signal.throwIfAborted();
  const completedBytes = boundedJsonBytes(messages, SUBAGENT_ROUTING_PARENT_BYTES);
  const receipt: SubagentRoutingReceipt = { selectionExecutionId: input.executionId, decision, actualPath: decision.path,
    conditions: { parentAvailable, parentMessageCount: messages.length, ...(completedBytes === undefined ? {} : { parentBytes: completedBytes }),
      messageBytes: Buffer.byteLength(input.message) } };

  return { receipt, diagnostics, ...(decision.path === "fork" ? { forkMessages: messages } : {}) };
}

/** Optional observers can report failure but never replace Runtime terminal or usage ownership. */
export function createSubagentRoutingObserver(input: {
  readonly port: SubagentRoutingPort; readonly receipt: SubagentRoutingReceipt; readonly executionId: string;
  readonly diagnostics?: readonly string[]; readonly now?: () => number; readonly scheduler?: TimerScheduler;
}) {
  const now = input.now ?? Date.now;
  const started = now();
  const requests = new Set<string>();
  const reportedUsage = new Set<string>();
  const diagnostics = [...(input.diagnostics ?? [])];
  const fail = (reason: string) => { if (!diagnostics.includes(reason)) diagnostics.push(reason); };

  return {
    usageReported(requestId: string): void { reportedUsage.add(requestId); },
    report(): JsonObject { return { ...input.receipt.decision, candidateIds: [...input.receipt.decision.candidateIds],
      actualPath: input.receipt.actualPath, selectionExecutionId: input.receipt.selectionExecutionId, diagnostics: [...diagnostics] }; },
    async dispatched(identity: { readonly taskId: string; readonly agentId: string; readonly round: number }, requestId: string) {
      if (requests.has(requestId)) return;
      requests.add(requestId);
      const observed = await observeOptional(() => input.port.dispatched({ ...input.receipt, ...identity,
        executionId: input.executionId, requestId }), input.scheduler);
      if (observed.kind !== "value") fail("routing_dispatch_failed");
    },
    async finished(identity: { readonly taskId: string; readonly agentId: string; readonly round: number }, result: SubagentResult) {
      const endState = result.status;
      if (endState === "pending" || endState === "running") {
        fail("routing_terminal_unavailable");
        return;
      }

      try {
        await input.port.finished({ ...input.receipt, ...identity, executionId: input.executionId, endState,
          usage: { ...result.usage, totalTokens: result.usage.inputTokens + result.usage.outputTokens,
            state: requests.size > 0 && [...requests].every(id => reportedUsage.has(id)) ? "reported" : "unknown" },
          dispatchedRequestIds: [...requests], latencyMs: Math.max(0, now() - started) });
      } catch { fail("routing_finish_failed"); } // Accounting failure remains visible; execution is already terminal.
    },
  };
}

export type SubagentRoutingObserver = ReturnType<typeof createSubagentRoutingObserver>;
