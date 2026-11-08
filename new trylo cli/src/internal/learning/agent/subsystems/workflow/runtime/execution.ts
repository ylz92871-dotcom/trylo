import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { ToolBinding, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import type { WorkflowLearningArtifact, WorkflowStep, WorkflowTrace } from "../domain/trace-contracts.js";
import { text } from "../domain/trace-parse.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import { parseEnvelope } from "../../../../../protocol/validate.js";
import { createWorkflowAccounting } from "./execution-accounting.js";
import { workflowCheckStatus } from "./check-receipt.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createWorkflowFailureReceipts } from "./execution-failures.js";
import { isExecutionExtensionMetadata } from "../../../../../ports/execution-extension.js";

const MAX_EVENTS = 2048;
const BINDING: ToolBinding = {
  name: "workflow_record_step",
  description: "Record one learned workflow checkpoint immediately after its exact run_shell check settles in this turn. Supply actual input/output references. Omit checkToolCallId to bind the unique fresh exact check automatically; only supply an ID from current workflow_progress.availableChecks, never historical evidence. Failed checks must use the learned recoveryTo when available. This records evidence; it grants no execution or permission.",
  sideEffect: "read_only", needsApproval: false, timeoutMs: 5000,
  outputLimits: { maxBytes: 8192, maxLines: 80 },
  parameters: { type: "object", additionalProperties: false, properties: {
    nodeId: { type: "string" }, input: { type: "string" }, output: { type: "string" },
    checkToolCallId: { type: "string" }, recoveryTo: { type: "string" }, inputBindings: { type: "object", additionalProperties: { type: "string" } },
  }, required: ["nodeId", "input", "output"] },
};

type CheckedCall = { readonly command: string; readonly status: "passed" | "failed"; readonly ref: string };

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function error(code: string, message: string): ToolOutcome { return { outcome: "error", code, message }; }

/** Only the normal execution journal can attest checks. The model nominates a
 * recorded call; it cannot nominate its status or mint an evidence reference.
 * The closure is a bounded projection of this run, not another executor/store.
 */
export function createWorkflowExecution(input: { readonly artifact: WorkflowLearningArtifact; readonly versionId: string; readonly traceId: string;
  readonly sessionId?: string; readonly resumeRecords?: readonly SessionRecord[]; readonly adoptedBranchId?: string;
  readonly executionId?: string;
  readonly conditions?: Readonly<Record<string, string>>; readonly conditionEvidenceRefs?: readonly string[];
  readonly outputDigest?: (reference: string) => string | undefined }) {
  const { artifact } = input;
  const pending = new Map<string, string>();
  const shellCalls = new Map<string, string>();
  const checks = new Map<string, CheckedCall>();
  const statuses = new Map<string, "passed" | "failed">();
  const steps: WorkflowStep[] = [];
  const outputs = new Map<string, WorkflowStep>();
  const recordCalls = new Map<string, JsonObject>();
  const deliveries = new Map<string, { readonly args: string; readonly outcome: ToolOutcome }>();
  const accounting = createWorkflowAccounting();
  const failureReceipts = createWorkflowFailureReceipts(artifact.nodes.map(node => node.check));
  let identity: { readonly sessionId: string; readonly turnId: string } | undefined;
  let terminal: string | undefined;
  let recoveryTo: string | undefined;
  let unrecordedFailure: { readonly nodeId: string; readonly ref: string } | undefined;
  let recoveryAmbiguous = false;
  let overflow = false;
  let observationFailure: string | undefined;

  function observe(envelope: Envelope, replay = false): void {
    if (envelope.producerId !== "loop" || envelope.sessionId === undefined || envelope.turnId === undefined) return;

    if (input.sessionId !== undefined && envelope.sessionId !== input.sessionId) return;

    if (identity !== undefined && envelope.turnId !== identity.turnId && envelope.kind === "turn_start") {
      pending.clear();
      shellCalls.clear();
      checks.clear();
      recordCalls.clear();
      terminal = undefined;
      identity = { sessionId: envelope.sessionId, turnId: envelope.turnId };
    }

    identity ??= { sessionId: envelope.sessionId, turnId: envelope.turnId };

    if (envelope.sessionId !== identity.sessionId || envelope.turnId !== identity.turnId) return;

    if (!accounting.observe(envelope)) return;

    if (envelope.kind === "terminal") {
      terminal = String(envelope.payload.reason);
      return;
    }

    const id = envelope.payload.toolCallId;
    if (typeof id !== "string") return;

    if (envelope.kind === "tool_use") {
      // A checkpoint attests the just-checked artifacts. Any intervening tool
      // could change them. Only our own local progress projection is known
      // read-only; external tools require a new check even when named a read.
      if (envelope.payload.name !== BINDING.name && envelope.payload.name !== "workflow_progress") {
        checks.clear();
        pending.clear();
      }

      // Reused ids cannot settle an earlier call, even when the new tool differs.
      pending.delete(id);
      checks.delete(id);
      shellCalls.delete(id);
      const args = object(envelope.payload.arguments);
      if (envelope.payload.name === BINDING.name && args !== undefined) recordCalls.set(id, args);

      if (pending.size >= MAX_EVENTS) {
        overflow = true;
        return;
      }

      if (envelope.payload.name === "run_shell" && typeof args?.command === "string") {
        if (shellCalls.size >= MAX_EVENTS) {
          overflow = true;
          return;
        }
        pending.set(id, args.command);
        shellCalls.set(id, args.command);
      }
    } else if (envelope.kind === "tool_result") {
      const recorded = recordCalls.get(id);

      recordCalls.delete(id);

      if (replay && recorded !== undefined && envelope.payload.status === "succeeded") {
        const actual = object(envelope.payload.value);
        const storedStep = object(actual?.step);
        const digest = typeof storedStep?.outputDigest === "string" && /^[a-f0-9]{64}$/.test(storedStep.outputDigest) ? storedStep.outputDigest : undefined;
        const result = recordDelivery(id, recorded, true, digest);
        if (result.outcome !== "result" || JSON.stringify(result.value.step) !== JSON.stringify(actual?.step)) {
          throw new Error("workflow_history_invalid: committed checkpoint does not match recorded checker and dependencies");
        }
      }

      const command = pending.get(id);

      pending.delete(id);
      const actualCommand = shellCalls.get(id);

      shellCalls.delete(id);
      const status = workflowCheckStatus(envelope.payload);
      const ref = `session:${identity.sessionId}/turn:${identity.turnId}/tool:${id}`;

      if (actualCommand !== undefined && status !== undefined) {
        if (!failureReceipts.observe(id, actualCommand, status, ref)) overflow = true;

        const failedNodes = status === "failed" ? artifact.nodes.filter(node => node.check === actualCommand && node.dependsOn.every(dependency => statuses.get(dependency) === "passed")) : [];
        if (failedNodes.length > 0) {
          for (const node of failedNodes) invalidateDescendants(node.id);
          const targets = new Set(failedNodes.map(node => artifact.recovery.find(item => item.afterNode === node.id)?.goto));
          if (targets.size > 1) recoveryAmbiguous = true;
          recoveryTo = targets.size === 1 ? [...targets][0] : undefined;
          unrecordedFailure = failedNodes.length === 1 ? { nodeId: failedNodes[0]!.id, ref } : undefined;
        }
      }

      if (command === undefined) return;

      if (checks.size >= MAX_EVENTS) {
        overflow = true;
        return;
      }

      if (status !== undefined) {
        checks.set(id, { command, status, ref });
      }
    }
  }

  function invalidateDescendants(nodeId: string): void {
    const changed = new Set([nodeId]);
    for (let round = 0; round < artifact.nodes.length; round += 1) {
      for (const node of artifact.nodes) if (node.dependsOn.some(id => changed.has(id))) changed.add(node.id);
    }
    for (const id of changed) {
      statuses.delete(id);
      outputs.delete(id);
    }
  }

  function record(args: JsonObject, replay = false, restoredDigest?: string): ToolOutcome {
    if (observationFailure !== undefined) return error("workflow_history_conflict", observationFailure);

    if (recoveryAmbiguous) return error("workflow_recovery_ambiguous", "the failed check matches nodes with conflicting recovery contracts; no node or recovery target can be safely inferred");

    if (overflow || steps.length >= 256) {
      overflow = true;
      return error("workflow_trace_limit", "workflow trace capacity exceeded; no success can be inferred");
    }

    const { nodeId, checkToolCallId } = args;
    const node = artifact.nodes.find(node => node.id === nodeId);
    if (node === undefined || (checkToolCallId !== undefined && !text(checkToolCallId)) || !text(args.input) || !text(args.output)) {
      return error("workflow_step_invalid", "a known node and bounded actual input/output references are required");
    }

    const candidates = [...checks].filter(([, checked]) => checked.command === node.check);
    const selectedId = checkToolCallId === undefined && candidates.length === 1 ? candidates[0]![0] : checkToolCallId;
    const checked = typeof selectedId === "string" ? checks.get(selectedId) : undefined;
    const recordingObservedFailure = checked?.status === "failed" && unrecordedFailure?.nodeId === node.id && unrecordedFailure.ref === checked.ref;
    if (recoveryTo !== undefined && node.id !== recoveryTo && !recordingObservedFailure) return error("workflow_recovery_required", `recover at ${recoveryTo} before recording another node`);

    if (node.dependsOn.some(id => statuses.get(id) !== "passed")) return error("workflow_dependency_unmet", "all node dependencies require fresh passed checkpoints");

    const bindings = Object.fromEntries(node.dependsOn.map(id => [id, outputs.get(id)!.output]));
    if (node.dependsOn.length === 1 && args.input !== Object.values(bindings)[0]) return error("workflow_input_mismatch", "the node must consume its dependency's actual output reference");

    const suppliedBindings = object(args.inputBindings);
    if (node.dependsOn.length > 1 && (suppliedBindings === undefined || Object.keys(suppliedBindings).length !== node.dependsOn.length
      || node.dependsOn.some(id => suppliedBindings[id] !== bindings[id]))) return error("workflow_input_mismatch", "inputBindings must match every dependency's actual output reference");

    if (checked === undefined || checked.command !== node.check) return error("workflow_check_unverified",
      `Require a unique fresh, settled run_shell call with the exact frozen check command. Omit checkToolCallId for automatic binding. Current exact receipts: ${JSON.stringify(candidates.map(([toolCallId, value]) => ({ toolCallId, command: value.command, status: value.status })))}`);

    const expected = artifact.recovery.find(item => item.afterNode === node.id)?.goto;
    if (checked.status === "failed" && args.recoveryTo !== expected) return error("workflow_recovery_invalid", `failed checkpoint recovery must be ${expected ?? "absent"}`);

    if (checked.status === "passed" && args.recoveryTo !== undefined) return error("workflow_recovery_invalid", "a passed checkpoint does not request recovery");

    // Checkpoints advance the evidence boundary. A check begun or completed
    // before this state change cannot attest any later dependent/recovery node.
    // Clearing both maps also rejects a late result from an in-flight old call.
    checks.clear();
    pending.clear();
    invalidateDescendants(node.id);
    statuses.set(node.id, checked.status);
    unrecordedFailure = undefined;
    recoveryTo = checked.status === "failed" ? expected : undefined;
    const outputDigest = replay ? restoredDigest : input.outputDigest?.(args.output);
    const step: WorkflowStep = { nodeId: node.id, input: args.input, output: args.output, dependsOn: node.dependsOn,
      check: node.check, status: checked.status, evidenceRefs: [checked.ref], ...(recoveryTo === undefined ? {} : { recoveryTo }),
      ...(node.dependsOn.length === 0 ? {} : { inputBindings: bindings }),
      ...(outputDigest === undefined ? {} : { outputDigest }) };

    steps.push(step);
    outputs.set(node.id, step);
    const value = { workflowVersionId: input.versionId, step: { ...step }, nextRecovery: recoveryTo ?? null };

    return { outcome: "result", value, output: JSON.stringify(value), truncated: false };
  }

  const tools: ToolPort = {
    snapshot: () => [BINDING, { ...BINDING, name: "workflow_progress", parameters: { type: "object", properties: {}, additionalProperties: false },
      description: "Read the frozen workflow branch, committed checkpoints, required recovery and ready nodes with actual upstream output bindings. availableChecks lists only this turn's fresh settled checker IDs. This local read preserves those checks; other tools invalidate them. This does not execute nodes." }],
    async execute(call, signal) {
      if (signal.aborted) return { outcome: "cancelled" };
      if (call.name === "workflow_progress") {
        const value = progress();
        return { outcome: "result", value, output: JSON.stringify(value), truncated: false };
      }
      if (call.name !== BINDING.name) return error("unknown_tool", `workflow port does not have ${call.name}`);
      return recordDelivery(call.toolCallId, call.arguments);
    },
    async cancel() { /* The record-only reducer settles synchronously. */ },
  };

  function recordDelivery(id: string, args: JsonObject, replay = false, restoredDigest?: string): ToolOutcome {
    const key = `${identity?.turnId ?? ""}:${id}`;
    const digest = contentHashOf(args);
    const old = deliveries.get(key);
    if (old !== undefined) return old.args === digest ? old.outcome : error("workflow_delivery_conflict", "a checkpoint delivery id cannot be rewritten");

    const outcome = record(args, replay, restoredDigest);
    if (outcome.outcome === "result") deliveries.set(key, { args: digest, outcome });

    return outcome;
  }

  function trace(): WorkflowTrace {
    const complete = artifact.nodes.length > 0 && artifact.nodes.every(node => statuses.get(node.id) === "passed");
    const failures = failureReceipts.snapshot(new Set(steps.filter(step => step.status === "failed").flatMap(step => step.evidenceRefs)));
    const outcome = observationFailure !== undefined || recoveryAmbiguous ? "unknown" : !overflow && terminal === "completed" && complete && recoveryTo === undefined && !failures.unrecovered ? "success"
      : terminal === "failed" || [...statuses.values()].includes("failed") || failures.unrecovered ? "failure" : "unknown";

    return { schemaVersion: 1, traceId: input.traceId, scope: artifact.scope, taskFamily: artifact.taskFamily,
      source: "runtime", workflowVersionId: input.versionId, steps: [...steps], outcome,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ...(failures.otherFailures.length === 0 ? {} : { otherFailures: failures.otherFailures }),
      ...(input.adoptedBranchId === undefined ? {} : { adoptedBranchId: input.adoptedBranchId }),
      ...(input.conditions === undefined ? {} : { conditions: input.conditions, conditionEvidenceRefs: input.conditionEvidenceRefs ?? [] }),
      runState: accounting.snapshot().runState,
      ...(accounting.snapshot().usageUncertain ? {} : { cost: { tokens: accounting.snapshot().tokens, wallMs: accounting.snapshot().wallMs } }) };
  }

  function progress(): JsonObject {
    return { workflowVersionId: input.versionId, adoptedBranchId: input.adoptedBranchId ?? null, ...accounting.snapshot(),
      availableChecks: [...checks].map(([toolCallId, checked]) => ({ toolCallId, command: checked.command, status: checked.status })),
      recoveryTo: recoveryTo ?? null, recoveryUnresolved: recoveryAmbiguous, checkpoints: [...outputs.values()].map(step => ({ ...step })),
      ready: artifact.nodes.filter(node => !recoveryAmbiguous && statuses.get(node.id) !== "passed" && node.dependsOn.every(id => statuses.get(id) === "passed")
        && (recoveryTo === undefined || recoveryTo === node.id)).map(node => ({ ...node,
        inputBindings: Object.fromEntries(node.dependsOn.map(id => [id, outputs.get(id)!.output])) })) };
  }

  for (const item of input.resumeRecords ?? []) {
    if (item.type === "execution_extension" && isExecutionExtensionMetadata(item.payload) && item.payload.owner === "workflow"
      && item.payload.instanceId === input.executionId && item.payload.configuration.kind === "checkpoint_invalidated") {
      const config = item.payload.configuration;
      if (config.schemaVersion !== 1 || config.stepDigest !== contentHashOf(steps) || !Array.isArray(config.nodeIds)
        || config.nodeIds.length === 0 || !config.nodeIds.every(id => typeof id === "string" && artifact.nodes.some(node => node.id === id))) {
        throw new Error("workflow_history_invalid: checkpoint invalidation does not match committed checkpoints");
      }

      for (const id of config.nodeIds) invalidateDescendants(String(id));

      pending.clear();
      checks.clear();
    }

    if (item.type !== "envelope") continue;

    const parsed = parseEnvelope(item.payload.envelope);
    if (!parsed.ok) throw new Error("workflow_history_invalid: malformed execution envelope");

    observe(parsed.envelope, true);
  }

  function revalidateOutputs() {
    const nodeIds: string[] = [];

    for (const step of [...outputs.values()]) {
      if (statuses.get(step.nodeId) !== "passed") continue;
      if (input.outputDigest !== undefined && (step.outputDigest === undefined || input.outputDigest(step.output) !== step.outputDigest)) {
        nodeIds.push(step.nodeId);
        invalidateDescendants(step.nodeId);
      }
    }

    return nodeIds.length === 0 ? undefined : { nodeIds, stepDigest: contentHashOf(steps) };
  }

  let restoredInvalidation: ReturnType<typeof revalidateOutputs>;

  if (input.resumeRecords !== undefined) {
    accounting.interrupted();
    pending.clear();
    checks.clear();
    recordCalls.clear();
    // A restarted process may only reuse the actual artifact it checked.
    restoredInvalidation = revalidateOutputs();
  }

  const capture = (envelope: Envelope, replay: boolean): void => {
    try { observe(envelope, replay); }
    catch (error) { observationFailure = error instanceof Error ? error.message : String(error); }
  };

  return { tools, observe: (envelope: Envelope) => capture(envelope, false), observeCommitted: (envelope: Envelope) => capture(envelope, true),
    trace, progress, accounting: accounting.snapshot, revalidateOutputs, restoredInvalidation };
}
