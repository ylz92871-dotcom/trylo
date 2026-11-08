import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { SessionRecord } from "../../ports/session.js";
import { isRuntimeFingerprint } from "../../ports/session.js";
import { isTranscriptItem } from "../../protocol/transcript.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { observeWorkflowTurn, workflowObservationWatermark } from "../../integration/workflow-learning/raw-facts.js";
import type { WorkflowObservedTurn } from "../../integration/workflow-learning/model-port.js";
import type { WorkflowLearningResult } from "../../learning/domains/workflow/trace-contracts.js";
import { workflowFailure } from "../../learning/domains/workflow/trace-parse.js";
import { isValidSessionId, sessionPath } from "./session-paths.js";
import type { CliContext } from "./context.js";

function userText(records: readonly SessionRecord[]): string | undefined {
  const direct = [...records].reverse().find(item => item.type === "turn_input" && typeof item.payload.text === "string");
  if (typeof direct?.payload.text === "string") return direct.payload.text;
  const users = records.flatMap(item => item.type === "transcript_item" && isTranscriptItem(item.payload) && item.payload.kind === "user" ? [item.payload.text] : []);
  return users.length === 0 ? undefined : users.join("\n");
}

export type WorkflowSessionEvidence = {
  readonly records: readonly SessionRecord[]; readonly text: string; readonly scope: string;
  readonly watermark: number; readonly turnStartSequence: number; readonly observed: WorkflowObservedTurn;
};

/** Read through the existing journal port; never attach, repair or rewrite a session. */
export async function workflowSessionEvidence(ctx: CliContext, sessionId: string, source: { readonly promptHash?: string; readonly turnId?: string; readonly journalWatermark?: number } = {}): Promise<WorkflowLearningResult<WorkflowSessionEvidence>> {
  if (!isValidSessionId(sessionId)) return workflowFailure("workflow_usage", "invalid session id");

  const read = await createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) }).readRecords();
  if (!read.ok) return workflowFailure(read.code, "the existing session journal is unreadable");

  if (read.view.tornTail) return workflowFailure("workflow_journal_torn", "repair or resume the session before learning from an incomplete journal tail");

  if (source.journalWatermark !== undefined && source.journalWatermark > (read.view.records.at(-1)?.sequence ?? -1)) return workflowFailure("workflow_watermark_unavailable", "the original classified evidence watermark is unavailable");

  const records = source.journalWatermark === undefined ? read.view.records : read.view.records.filter(item => item.sequence <= source.journalWatermark!);
  const start = records.find(item => item.type === "session_start");
  if (start === undefined || !isRuntimeFingerprint(start.payload.fingerprint)) return workflowFailure("workflow_session_identity_missing", "session has no canonical workspace fingerprint");

  const turnIds = source.turnId === undefined ? [...new Set(records.filter(item => item.sessionId === sessionId && item.turnId !== undefined
    && ["turn_start", "turn_input", "terminal", "transcript_item"].includes(item.type)).map(item => item.turnId!))].reverse() : [source.turnId];

  for (const turnId of turnIds) {
    const facts = records.filter(item => item.sessionId === sessionId && item.turnId === turnId);
    const text = userText(facts);
    if (text === undefined || (source.promptHash !== undefined && contentHashOf(text.slice(0, 12000)) !== source.promptHash)) {
      if (source.promptHash === undefined) return workflowFailure("workflow_user_input_missing", "current turn has no visible user input; no prior task was substituted");
      continue;
    }

    const watermark = workflowObservationWatermark(records, turnId);
    const snapshot = records.filter(item => item.sequence <= watermark);
    const observed = observeWorkflowTurn(snapshot, turnId);
    if (!observed.ok) return observed;

    const turnStartSequence = facts[0]?.sequence ?? 0;

    // Resolver also needs committed post-terminal seals/invalidations. They do
    // not change the model observation or classification's stable watermark.
    return { ok: true, value: { records, text: text.slice(0, 12000), scope: start.payload.fingerprint.workspaceId,
      watermark, turnStartSequence, observed: observed.value } };
  }

  return workflowFailure("workflow_user_input_missing", "no identified turn matches this classification input");
}
