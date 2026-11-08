import { contextFromProfile } from "../../contract/context.js";
import { createCompactionLedger, adoptResumedWindow } from "../../loop/compact-boundary.js";
import { buildRequest, seedMessagesOf } from "../../loop/request.js";
import { isTranscriptItem } from "../../protocol/transcript.js";
import { EXIT_CODES, type CliRunResult } from "../../protocol/cli-stream.js";
import type { SessionRecord } from "../../ports/session.js";
import { readSummaryAuthorReport, type SummaryAuthorReport } from "../../ports/compaction.js";
import type { TurnHostInput, TurnOutcome } from "./host.js";
import type { Wiring } from "./wiring.js";
import { createProjection } from "./render.js";
import { compactSession } from "./compact-session.js";
import { agentMessages } from "./agent-instructions.js";
import { budgetOf, pricingOf } from "./turn-execution.js";
import { accountingToCli, usageToCli } from "./host-status.js";
import { authoringContext, auxiliarySpendingUnavailable, chargeAuxiliaryUsage, createParentUsageState,
  parentUsageFields, spendingVerdict } from "../../loop/auxiliary-usage.js";

/** Maintenance owns no model turn. It reuses the session writer and normal prompt projection. */
export async function executeCompaction(input: TurnHostInput, wiring: Wiring): Promise<TurnOutcome> {
  const projection = createProjection(input.format, input.sink);
  const startedAt = input.now();
  const accounting = createParentUsageState(pricingOf(input)), budget = budgetOf(input) ?? {};
  const checkSpending = (): void => {
    if (auxiliarySpendingUnavailable(accounting.auxiliary, budget)) throw new Error("auxiliary_usage_unavailable");
    const verdict = spendingVerdict(accounting.usage, accounting.costUsd, budget);
    if (verdict.kind !== "within_budget") throw new Error(verdict.kind);
  };

  projection.onEvent({ type: "run_start", sessionId: input.sessionId, turnId: input.turnId,
    providerId: wiring.providerId, model: wiring.model, operation: "compact",
    ...(input.contextTokenLimit === undefined ? {} : { contextWindow: input.contextTokenLimit }) });
  let result: CliRunResult;
  let window = input.resumeView;
  let summaryAuthor: SummaryAuthorReport | undefined;

  try {
    checkSpending();

    if (!input.session || !wiring.ports.compaction) throw new Error("session_unavailable");

    const read = await input.session.readRecords();
    if (!read.ok) throw new Error(read.code);

    const records = read.view.records;
    const compaction = wiring.ports.compaction;
    const abort = input.cancelSignal ?? new AbortController().signal;
    const assembled = await contextFromProfile(wiring.ports.profile).assemble({ taskId: input.turnId,
      messages: agentMessages(input.projectContext?.messages, budgetOf(input)), signal: abort });
    const measure = (journal: readonly SessionRecord[]): number => {
      const projected = compaction.port.projectForPrompt({ records: journal });
      if (!projected.ok) throw new Error(projected.code);

      const transcript = journal.flatMap(record => record.type === "transcript_item" && isTranscriptItem(record.payload) ? [record.payload] : []);
      const ledger = createCompactionLedger();

      adoptResumedWindow(ledger, projected.view.window, journal, transcript);
      const prompt = { seedMessages: seedMessagesOf(assembled.messages), transcript, ledger };
      const request = buildRequest({ attemptId: undefined, model: input.model, tools: wiring.ports.tools, prompt,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.systemPromptAppend === undefined ? {} : { systemPromptAppend: input.systemPromptAppend }) });

      return compaction.estimatePromptTokens(request.messages) + (compaction.estimateOverheadTokens?.(wiring.ports.tools) ?? 0);
    };
    const before = measure(records);

    projection.onEvent({ type: "compact", status: "started", tokensBefore: before, reason: "manual" });
    const done = await compactSession({ now: input.now }, input.sessionId, records, input.session, {
      wiring: compaction, signal: abort,
      reportSummary: report => { summaryAuthor = readSummaryAuthorReport(report.author, report.reason); },
      authoring: authoringContext(accounting.usage, budget, receipt => chargeAuxiliaryUsage(accounting, receipt)),
      accept: draft => measure([...records, { ...draft, formatVersion: records[0]?.formatVersion ?? "1",
        sequence: (records.at(-1)?.sequence ?? -1) + 1 }]) < before,
    });
    if (!done.ok) throw new Error(done.problem);

    window = done.window;
    checkSpending();
    const after = await input.session.readRecords();
    if (!after.ok) throw new Error(after.code);

    projection.onEvent({ type: "compact", status: "completed", tokensBefore: before, tokensAfter: measure(after.view.records), reason: "manual",
      ...(summaryAuthor === undefined ? {} : { summaryAuthor }) });
    result = { type: "run_result", status: "completed", finishReason: "compacted", sessionId: input.sessionId,
      turnId: input.turnId, iterations: 0, usage: usageToCli(accounting.usage), ...accountingToCli(parentUsageFields(accounting)),
      durationMs: Math.max(0, input.now() - startedAt), lastMessage: "" };
  } catch (error) {
    // Only typed local operation codes are shown, never summaries or provider bodies.
    const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "compaction_failed";
    projection.onEvent({ type: "compact", status: "failed", reason, ...(summaryAuthor === undefined ? {} : { summaryAuthor }) });
    result = { type: "run_result", status: input.cancelSignal?.aborted ? "cancelled" : "failed", finishReason: reason,
      sessionId: input.sessionId, turnId: input.turnId, iterations: 0, usage: usageToCli(accounting.usage), ...accountingToCli(parentUsageFields(accounting)),
      durationMs: Math.max(0, input.now() - startedAt), lastMessage: "" };
  }

  projection.onEvent(result);

  return { exitCode: result.status === "completed" ? EXIT_CODES.OK : result.status === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE,
    result, transcript: input.resumeTranscript ?? [], view: window, warnings: [] };
}
