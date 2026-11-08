import type { SessionRecord, SessionRecordViewOutcome } from "../../../../../ports/session.js";
import type { WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isRuntimeFingerprint } from "../../../../../ports/session.js";
import { record } from "../domain/trace-parse.js";
import { isTranscriptItem } from "../../../../../protocol/transcript.js";
import { resolveLatestWorkflowInstance, persistWorkflowInstanceFeedback } from "./run-adoption.js";
import { workflowFeedback } from "./archive.js";

export type WorkflowStudyArm = {
  readonly arm: "baseline" | "candidate"; readonly sessionId: string; readonly versionId: string;
  readonly task: WorkflowTask; readonly inputText: string; readonly inputHash: string;
  /** Host-declared authorization reference; the journal proves the numeric cap, not this reference. */
  readonly hostDeclaredOutputGrantRef: string; readonly maxOutputTokens: number;
};

/** Trusted host capability: create this exact session through the existing SessionPort
 * before any execution. Session start/execution owns idempotency and permissions.
 * Return no pass verdict or bill; those are read independently from its journal. */
export type WorkflowStudyHost = {
  executeOnce(input: WorkflowStudyArm & { readonly signal: AbortSignal }): Promise<void>;
  readRecords(sessionId: string): Promise<SessionRecordViewOutcome>;
};

export type VerifiedWorkflowStudyArm = {
  readonly sessionId: string; readonly executionId: string; readonly feedbackVersionId: string;
  readonly trace: WorkflowTrace; readonly maxOutputTokens: number;
};

export type StudyArmResult = { readonly ok: true; readonly value: VerifiedWorkflowStudyArm }
  | { readonly ok: false; readonly reason: string };

const unavailable = (reason: string): StudyArmResult => ({ ok: false, reason });

function refused(records: readonly SessionRecord[]): boolean {
  return records.some(item => {
    const envelope = item.type === "envelope" ? item.payload.envelope : undefined;
    const payload = record(envelope) && record(envelope.payload) ? envelope.payload : undefined;
    return record(envelope) && (envelope.kind === "permission_denied" || (payload !== undefined
      && (payload.refused === true || payload.decision === "denied" || payload.status === "denied")));
  });
}

function sameInput(records: readonly SessionRecord[], turnId: string | undefined, inputHash: string): boolean {
  const turns = records.filter(item => item.type === "turn_start");
  if (turns.length !== 1 || turns[0]!.turnId !== turnId) return false;
  const direct = records.filter(item => item.type === "turn_input");
  const users = records.filter(item => item.type === "transcript_item" && isTranscriptItem(item.payload) && item.payload.kind === "user");
  if (direct.length > 1 || users.length > 1 || direct.length + users.length === 0) return false;
  return [...direct, ...users].every(item => item.turnId === turnId && typeof item.payload.text === "string" && contentHashOf(item.payload.text) === inputHash);
}

/** No model-supplied trace enters this boundary. The supplied reader is an explicit
 * host authority, normally createNdjsonSessionStore(...).readRecords(). */
export async function verifyWorkflowStudyArm(options: {
  readonly boardRoot: string; readonly arm: WorkflowStudyArm; readonly host: WorkflowStudyHost;
  readonly active: () => boolean; readonly signal: AbortSignal; readonly issuedAt: string;
}): Promise<StudyArmResult> {
  const { arm, host, signal, active } = options;

  if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");

  let read = await host.readRecords(arm.sessionId);

  if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");

  if (!read.ok && read.code === "missing_session") {
    await host.executeOnce({ ...arm, signal });
    if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");
    read = await host.readRecords(arm.sessionId);
  }

  if (!read.ok || read.view.tornTail) return unavailable("workflow_topic_journal_unknown");

  const records = read.view.records;
  if (records.length > 8192) return unavailable("workflow_topic_journal_capacity");

  const start = records[0];
  if (start?.sessionId !== arm.sessionId || start.type !== "session_start"
    || !isRuntimeFingerprint(start.payload.fingerprint) || start.payload.fingerprint.workspaceId !== arm.task.scope) {
    return unavailable("workflow_topic_session_binding");
  }

  if (refused(records)) return unavailable("workflow_topic_permission_unknown");

  if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");

  const resolved = await resolveLatestWorkflowInstance(options.boardRoot, records);
  if (!resolved.ok || resolved.value === undefined) return unavailable("workflow_topic_execution_unknown");

  const { instance, trace, terminalTurnId } = resolved.value;

  if (instance.adoption.versionId !== arm.versionId || contentHashOf(instance.adoption.task) !== contentHashOf(arm.task)
    || !sameInput(records, terminalTurnId, arm.inputHash)) return unavailable("workflow_topic_task_binding");

  if (trace.runState !== "completed" || trace.outcome === "unknown"
    || (trace.outcome === "success" && instance.completion === undefined)) return unavailable("workflow_topic_check_unknown");

  const budget = trace.budgetReceipt;
  if (trace.cost === undefined || budget === undefined || budget.usageUncertain || instance.grants.length !== 0
    || instance.adoption.budget.maxOutputTokens !== arm.maxOutputTokens || budget.initialTokens !== arm.maxOutputTokens
    || budget.grantedTokens !== 0 || budget.reservedUnknownTokens !== 0 || budget.observedOutputTokens > arm.maxOutputTokens) {
    return unavailable("workflow_topic_usage_unknown");
  }

  if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");

  const saved = await persistWorkflowInstanceFeedback(options.boardRoot, resolved.value, options.issuedAt);
  if (!saved.ok) return unavailable("workflow_topic_feedback_unknown");

  if (!active() || signal.aborted) return unavailable("workflow_topic_stopped");

  const feedback = await workflowFeedback(options.boardRoot, arm.versionId);
  if (!feedback.ok || !feedback.value.some(item => contentHashOf(item) === contentHashOf(trace))) {
    return unavailable("workflow_topic_feedback_binding");
  }

  return { ok: true, value: { sessionId: arm.sessionId, executionId: instance.adoption.instanceId,
    feedbackVersionId: saved.value.versionId, trace, maxOutputTokens: arm.maxOutputTokens } };
}
