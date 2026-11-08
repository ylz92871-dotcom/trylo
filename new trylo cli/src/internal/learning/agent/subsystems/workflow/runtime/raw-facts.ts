import type { SessionRecord } from "../../../../../ports/session.js";
import { isTranscriptItem } from "../../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowLearningResult, WorkflowStep, WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { parseWorkflowTrace, record, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowObservedTurn, WorkflowTraceProposal } from "./model-port.js";
import { workflowCheckStatus } from "./check-receipt.js";

const SECRET_COMMAND = /(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]|-----BEGIN .*PRIVATE KEY|\b(?:sk|ghp)-[A-Za-z0-9])/i;

function object(value: unknown): JsonObject | undefined { return record(value) ? value as JsonObject : undefined; }

/** Lifecycle seals and learning metadata do not create a new evidence snapshot. */
export function workflowObservationWatermark(records: readonly SessionRecord[], turnId: string): number {
  const facts = records.filter(item => item.turnId === turnId);
  return [...facts].reverse().find(item => item.type === "terminal")?.sequence
    ?? [...facts].reverse().find(item => ["turn_start", "turn_input", "transcript_item", "envelope"].includes(item.type))?.sequence ?? 0;
}

/** Pair actual root-loop facts, excluding child calls and hidden reasoning. */
export function observeWorkflowTurn(records: readonly SessionRecord[], turnId?: string): WorkflowLearningResult<WorkflowObservedTurn> {
  const latest = [...records].reverse().find(item => item.turnId !== undefined
    && ["turn_start", "turn_input", "transcript_item", "terminal"].includes(item.type));
  const selected = turnId ?? latest?.turnId;
  const facts = records.filter(item => item.turnId === selected);
  const sessionId = facts[0]?.sessionId;
  if (selected === undefined || sessionId === undefined) return workflowFailure("workflow_no_turn", "no identified execution turn is available");

  const calls = new Map<string, { name: string; args: JsonObject }>();
  const transcript = new Map<string, { name: string; args: JsonObject }>();
  const checks: WorkflowObservedTurn["checks"][number][] = [], mutations: WorkflowObservedTurn["mutations"][number][] = [];
  const artifacts: NonNullable<WorkflowObservedTurn["artifacts"]>[number][] = [];

  for (const item of facts) {
    if (item.type === "transcript_item" && isTranscriptItem(item.payload) && item.payload.kind === "tool_call") {
      transcript.set(item.payload.toolCallId, { name: item.payload.name, args: item.payload.arguments });
    }

    if (item.type !== "envelope") continue;

    const envelope = object(item.payload.envelope), payload = object(envelope?.payload);
    if (envelope?.producerId !== "loop" || envelope.sessionId !== sessionId || envelope.turnId !== selected || payload === undefined) continue;

    const id = payload.toolCallId;
    if (typeof id !== "string") continue;

    if (envelope.kind === "tool_use") {
      calls.delete(id);
      const name = payload.name, original = transcript.get(id);
      const args = object(payload.arguments) ?? (original?.name === name ? original?.args : undefined);
      if (typeof name === "string" && args !== undefined) calls.set(id, { name, args });
    } else if (envelope.kind === "tool_result") {
      const call = calls.get(id);
      calls.delete(id);

      if (call === undefined) continue;

      const ref = `session:${sessionId}/turn:${selected}/tool:${id}`;

      if (call.name === "run_shell" && typeof call.args.command === "string" && !SECRET_COMMAND.test(call.args.command)) {
        const status = workflowCheckStatus(payload);
        if (status !== undefined) checks.push({ toolCallId: id, command: call.args.command, status, evidenceRef: ref, sequence: item.sequence });
      }

      if (["write_file", "edit_file", "apply_patch"].includes(call.name) && payload.status === "succeeded" && typeof call.args.path === "string") {
        mutations.push({ toolCallId: id, path: call.args.path, evidenceRef: ref, sequence: item.sequence });
      }

      if (call.name === "read_file" && payload.status === "succeeded" && typeof call.args.path === "string") {
        artifacts.push({ toolCallId: id, path: call.args.path, evidenceRef: ref, sequence: item.sequence });
      }
    }

    if (checks.length + mutations.length + artifacts.length > 128) return workflowFailure("workflow_observation_limit", "execution facts exceed this round's observation window");
  }

  const ended = [...facts].reverse().find(item => item.type === "terminal");
  const reason = ended?.payload.reason;
  const outcome = reason === "completed" || reason === "failed" || reason === "cancelled" ? reason : "unknown";
  const usage = object(ended?.payload.usage);
  const usageKnown = typeof usage?.totalTokens === "number" && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0;
  const tokens = usageKnown ? Number(usage!.totalTokens) : 0;
  const sourceEnd = facts.find(item => item.sequence === workflowObservationWatermark(facts, selected));
  const startAt = Date.parse(facts[0]?.at ?? ""), endAt = Date.parse(sourceEnd?.at ?? "");

  return { ok: true, value: { sessionId, turnId: selected, checks, mutations, artifacts, terminal: outcome, tokens,
    ...(usageKnown ? {} : { usageUncertain: true }),
    wallMs: Number.isFinite(startAt) && Number.isFinite(endAt) ? Math.max(0, endAt - startAt) : 0 } };
}

/** Model segmentation never supplies status/command/evidence or a success verdict. */
export function bindWorkflowProposal(task: WorkflowTask, observed: WorkflowObservedTurn, proposal: WorkflowTraceProposal): WorkflowLearningResult<WorkflowTrace> {
  const used = new Set<string>(), excluded = new Set<string>();

  for (const item of proposal.excludedCalls ?? []) {
    if (excluded.has(item.toolCallId) || !observed.checks.some(check => check.toolCallId === item.toolCallId)) return workflowFailure("workflow_receipt_mismatch", "non-checkpoint calls must bind unique actual receipts");
    excluded.add(item.toolCallId);
  }

  const checkpoints = observed.checks.filter(check => !excluded.has(check.toolCallId));
  const artifacts = [...observed.mutations, ...(observed.artifacts ?? [])];
  const steps: WorkflowStep[] = [];
  const latestNodeCheck = new Map<string, { output: string; sequence: number }>();
  const passedOutputs = new Map<string, string>();

  for (const [index, proposed] of proposal.steps.entries()) {
    const check = checkpoints[index];
    if (check?.toolCallId !== proposed.checkToolCallId) return workflowFailure("workflow_receipt_order", "workflow steps must preserve actual checker order");

    if (check === undefined || used.has(check.toolCallId)) return workflowFailure("workflow_receipt_mismatch", "each proposed step must bind one unique real checker receipt");

    const inputBindings: Record<string, string> = {};

    for (const dependency of proposed.dependsOn) {
      const output = passedOutputs.get(dependency);
      if (output === undefined) return workflowFailure("workflow_dependency_unverified", "a dependency must have an earlier passed product");
      inputBindings[dependency] = output;
    }

    if (proposed.dependsOn.length === 1 && proposed.input !== Object.values(inputBindings)[0]) {
      return workflowFailure("workflow_input_mismatch", "a consumer must use its producer's actual output reference");
    }

    if (check.status === "passed" && !artifacts.some(artifact => artifact.path === proposed.output && artifact.sequence < check.sequence)) {
      return workflowFailure("workflow_artifact_unobserved", "the output must be observed before its checkpoint");
    }

    used.add(check.toolCallId);
    latestNodeCheck.set(proposed.nodeId, { output: proposed.output, sequence: check.sequence });
    steps.push({ nodeId: proposed.nodeId, input: proposed.input, output: proposed.output, dependsOn: proposed.dependsOn,
      check: check.command, status: check.status, evidenceRefs: [check.evidenceRef], inputBindings,
      ...(proposed.recoveryTo === undefined || check.status === "passed" ? {} : { recoveryTo: proposed.recoveryTo }) });

    if (check.status === "passed") passedOutputs.set(proposed.nodeId, proposed.output);
    else passedOutputs.delete(proposed.nodeId);
  }

  if (observed.checks.some(check => !used.has(check.toolCallId) && !excluded.has(check.toolCallId))) return workflowFailure("workflow_checks_omitted", "all observed successful and failed checks must remain in the learning trace");

  const id = `observed:${observed.sessionId}:${observed.turnId}`;
  const stale = [...latestNodeCheck.values()].some(checked => observed.mutations.some(mutation => mutation.path === checked.output && mutation.sequence > checked.sequence));
  const failures = observed.checks.filter(check => excluded.has(check.toolCallId) && check.status === "failed");
  const unrecovered = failures.some(failed => !observed.checks.some(check => check.sequence > failed.sequence && check.command === failed.command && check.status === "passed"));
  const trace: WorkflowTrace = { ...task, schemaVersion: 1, traceId: id, source: "imported", steps,
    outcome: unrecovered ? "failure" : observed.terminal === "completed" && !stale ? "success" : observed.terminal === "failed" ? "failure" : "unknown",
    sessionId: observed.sessionId, conditionEvidenceRefs: [`session:${observed.sessionId}/turn:${observed.turnId}/input`],
    ...(observed.terminal === "unknown" || observed.usageUncertain === true ? {} : { cost: { tokens: observed.tokens, wallMs: observed.wallMs } }),
    runState: observed.terminal === "unknown" ? "interrupted" : observed.terminal,
    otherFailures: failures.map(check => ({ toolCallId: check.toolCallId, command: check.command, evidenceRef: check.evidenceRef })) };
  const verified = parseWorkflowTrace(trace);

  // A completed task with unchecked recovery is still a failed learning episode.
  return !verified.ok && trace.outcome === "success" ? parseWorkflowTrace({ ...trace, outcome: steps.some(step => step.status === "failed") ? "failure" : "unknown" }) : verified;
}
