import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import path from "node:path";
import { createSkillTaskQueue, type SkillTaskQueueEntry } from "../../integration/skill-learning/task-queue.js";
import { createSkillExperienceFile } from "../../integration/skill-learning/experience-file.js";
import { skillTaskIdentity } from "../../integration/skill-learning/task-identity.js";
import type { createSkillTaskModel } from "../../integration/skill-learning/model-task.js";
import type { SkillModelAllowance, SkillModelUsage, SkillTaskExtractionInput } from "../../integration/skill-learning/task-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { sameSkillTaskFamily } from "../../learning/domains/skill/conditions.js";
import { parseEnvelope } from "../../protocol/validate.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { CliContext } from "./context.js";
import { isValidSessionId, sessionPath } from "./session-paths.js";
import { skillJournalUses, skillUseBeforeCheck } from "./skill-journal-usage.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { skillDailyManagementPaths } from "./skill-daily-management.js";
import { skillDailyCheckRef } from "./skill-daily-checks.js";
import { actualSkillCheckExit } from "./skill-daily-check-exit.js";

type IntakeInput = {
  readonly ctx: CliContext;
  readonly workspaceId: string;
  readonly root: string;
  readonly revision: string;
  readonly model: () => ReturnType<typeof createSkillTaskModel>;
  readonly allowance: () => SkillModelAllowance;
  readonly account: (usage: SkillModelUsage) => void;
  readonly signal: AbortSignal;
  readonly maxTasks: number;
  readonly onExtracted?: (entry: SkillTaskQueueEntry, result: Awaited<ReturnType<ReturnType<typeof createSkillTaskModel>["extract"]>>) => void;
};

/** Recover pending work from the execution owner's journal, without copying user text into a second log. */
export async function processSkillTaskIntake(input: IntakeInput) {
  if (input.signal.aborted) return { processed: 0, failed: 0, waiting: 0, blocked: 0 };

  const queue = createSkillTaskQueue({ root: input.root, workspaceId: input.workspaceId, collection: () => "enabled" });
  const history = createSkillExperienceFile({ root: input.root, workspaceId: input.workspaceId, collection: () => "enabled", retention: "segmented" });
  const pending = queue.pending({ limit: Math.max(1, Math.min(8, input.maxTasks)), retryRevision: input.revision, includeRecovery: true });
  if (!pending.ok) throw new Error(pending.code);

  let processed = 0, failed = 0;

  for (const entry of pending.entries) {
    if (input.signal.aborted) break;

    const existing = history.read(input.revision);
    if (!existing.ok) throw new Error(existing.code);

    const recoveredFact = existing.opportunity.experiences.find(fact => fact.runId === `${entry.task.sessionId}:${entry.task.turnId}`
      && fact.qualification.ref === entry.task.qualification.ref && sameSkillTaskFamily(fact.episode.taskFamily, entry.task.expectedFamily));
    if (recoveredFact !== undefined && entry.state === "running" && entry.lastRevision !== undefined) {
      const identity = skillTaskIdentity(entry.task);
      if (recoveredFact.episode.id !== identity.episodeId || recoveredFact.sourceRef !== identity.sourceRef
        || recoveredFact.qualification.kind !== entry.task.qualification.kind
        || recoveredFact.episode.outcome !== entry.task.qualification.outcome
        || contentHashOf(recoveredFact.usedSkill ?? null) !== contentHashOf(entry.task.usedSkill ?? null)) {
        throw new Error("task_fact_recovery_mismatch");
      }

      const ack = queue.ack(entry.key, { attempt: entry.attempt, retryRevision: entry.lastRevision,
        result: { kind: "processed", experienceId: recoveredFact.episode.id, experienceHash: contentHashOf(recoveredFact) } });
      if (!ack.ok) throw new Error(ack.code);

      processed += 1;
      continue;
    }

    if (input.allowance().maxModelCalls === 0) continue;

    const claimed = queue.claim(entry.key, { retryRevision: input.revision });
    if (!claimed.ok) throw new Error(claimed.code);

    if (claimed.status !== "claimed" || claimed.entry === undefined) continue;

    const owner = claimed.entry;
    let factCommitted = false;

    try {
      const task = await readJournalTask(input.ctx, owner, input.workspaceId);
      const result = await input.model().extract({ ...task, priorEpisodes: existing.opportunity.experiences.map(fact => fact.episode),
        priorFamilies: existing.opportunity.experiences.map(fact => fact.episode.taskFamily) }, input.allowance(), input.signal);

      input.account(result.usage);
      input.onExtracted?.(owner, result);

      if (input.signal.aborted) {
        const stopped = queue.ack(owner.key, { attempt: owner.attempt, retryRevision: input.revision,
          result: { kind: "cancelled", reason: "cancelled" } });
        if (!stopped.ok) throw new Error(stopped.code);
        failed += 1;
        break;
      }

      if (result.kind === "experience") {
        const saved = history.append(result.experience);
        if (!saved.ok) throw new Error(saved.code);
        factCommitted = true;
        const ack = queue.ack(owner.key, { attempt: owner.attempt, retryRevision: input.revision,
          result: { kind: "processed", experienceId: result.experience.episode.id, experienceHash: contentHashOf(result.experience) } });
        if (!ack.ok) throw new Error(ack.code);
        processed += 1;
      } else {
        const ack = queue.ack(owner.key, { attempt: owner.attempt, retryRevision: input.revision,
          result: { kind: result.kind === "cancelled" ? "cancelled" : "extraction_failure", reason: result.reason } });
        if (!ack.ok) throw new Error(ack.code);
        failed += 1;
      }
    } catch (error) {
      if (factCommitted) throw error;

      // Keep the source queued at a bounded retry state; never infer success
      // from an exception or drop the original journal coordinates.
      const ack = queue.ack(owner.key, { attempt: owner.attempt, retryRevision: input.revision,
        result: { kind: input.signal.aborted ? "cancelled" : "extraction_failure", reason: "journal_extraction_unavailable" } });
      if (!ack.ok) throw new Error(ack.code);

      failed += 1;
    }
  }

  return { processed, failed, waiting: pending.totalPending - processed, blocked: pending.blocked };
}

async function readJournalTask(ctx: CliContext, entry: SkillTaskQueueEntry, workspaceId: string): Promise<SkillTaskExtractionInput> {
  const task = entry.task;
  if (!isValidSessionId(task.sessionId) || task.workspaceId !== workspaceId) throw new Error("task_journal_identity_mismatch");

  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, task.sessionId) });
  const [recovered, recorded] = await Promise.all([store.read(), store.readRecords()]);

  if (!recovered.ok || !recorded.ok || recorded.view.tornTail || recovered.session.fingerprint.workspaceId !== workspaceId) throw new Error("task_journal_unavailable");

  const records = recorded.view.records.filter(item => item.turnId === task.turnId);
  if (!records.some(item => item.type === "terminal")) throw new Error("task_journal_not_settled");

  const transcript = records.filter(item => item.type === "transcript_item").flatMap(item => {
    const matched = recovered.session.transcript.find(transcript => transcript.sequence === item.payload.sequence);
    return matched === undefined || matched.sequence < task.fromSequence || matched.sequence > task.sourceSequence ? [] : [matched];
  });
  const user = transcript.find(item => item.kind === "user");
  if (user?.kind !== "user") throw new Error("task_journal_user_missing");

  const events: Envelope[] = [];

  for (const record of records.filter(item => item.type === "envelope")) {
    const parsed = parseEnvelope(record.payload.envelope);
    if (!parsed.ok) throw new Error("task_journal_event_invalid");
    if (parsed.envelope.sessionId !== task.sessionId || parsed.envelope.turnId !== task.turnId) throw new Error("task_journal_event_identity_mismatch");
    events.push(parsed.envelope);
  }

  if (task.qualification.kind === "external_check" && task.qualification.checks.some(check => !events.some(event => event.eventId === check.eventId && event.kind === "tool_result"))) throw new Error("task_journal_check_unbound");

  if (task.qualification.kind === "external_check") {
    for (const check of task.qualification.checks) {
      const source = events.find(event => event.eventId === check.eventId);
      const call = transcript.find(item => item.kind === "tool_call" && item.toolCallId === source?.payload.toolCallId);
      const result = transcript.find(item => item.kind === "tool_result" && item.toolCallId === source?.payload.toolCallId);
      if (call?.kind !== "tool_call" || result?.kind !== "tool_result" || call.name !== "run_shell" || call.arguments.command !== task.checker.command
        || task.qualification.ref !== skillDailyCheckRef(call.toolCallId)
        || Object.keys(call.arguments).some(key => !["command", "cwd", "timeoutMs", "runInBackground"].includes(key)) || call.arguments.runInBackground === true
        || (call.arguments.cwd !== undefined && (typeof call.arguments.cwd !== "string" || path.relative(path.resolve(ctx.cwd), path.resolve(ctx.cwd, call.arguments.cwd)) !== ""))
        || result.sequence !== task.sourceSequence || actualSkillCheckExit(result, source) === undefined
        || (task.qualification.outcome === "success" ? result.outcome !== "succeeded" : result.outcome !== "failed")) throw new Error("task_journal_check_mismatch");
    }
  }

  if (task.usedSkill !== undefined) {
    const board = await createBoardReader(skillDailyManagementPaths(ctx).boardRoot).load();
    if (!board.ok) throw new Error("task_journal_skill_unavailable");
    const use = skillUseBeforeCheck(skillJournalUses({ state: board.state, workspaceId, contentRoot: ctx.cwd,
      sessionId: task.sessionId, turnId: task.turnId, fromSequence: task.fromSequence, transcript, events }), board.state, task.expectedFamily, task.sourceSequence);
    if (!use || use.versionId !== task.usedSkill.versionId || use.variantId !== task.usedSkill.variantId || use.contentHash !== task.usedSkill.contentHash) throw new Error("task_journal_skill_mismatch");
  }

  return { workspaceId, sessionId: task.sessionId, turnId: task.turnId, fromSequence: task.fromSequence, taskText: user.text, transcript, events,
    qualification: task.qualification, expectedFamily: task.expectedFamily, ...(task.usedSkill === undefined ? {} : { usedSkill: task.usedSkill }) };
}
