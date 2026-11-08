import type { CheckExperience, CheckInput } from "../domain/v2/contracts.js";
import { parseCheckInput } from "../domain/v2/parse.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { RunTurnResult, LoopPorts } from "../../../../../loop/runner.js";
import { readFileWriteRecords } from "../../../../../loop/tool-effects.js";
import type { Envelope } from "../../../../../protocol/envelope.js";
import type { ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { estimateMessagesTokens } from "../../../../../compaction/token-estimate.js";
import { taskIdentity, toolFacts, jsonOutput, formatRuns } from "./turn-facts.js";
import type { CheckTurnInput, DailyCheckRun } from "./turn-contracts.js";

/** Existing check scheduling and capture policy, expressed only in canonical facts and borrowed ports. */
export function createCheckTurn(input: CheckTurnInput) {
  const learning = input.runtime, signal = input.signal, allowance = input.allowance, warn = input.warn;
  const priorRuns: string[] = [];
  const corrections: Envelope[] = [];
  const pending: { readonly facts: CheckInput; readonly identity: string; readonly paths: readonly string[] }[] = [];
  let feedback = "";
  const tools = input.ports.tools;
  const check = async (facts: CheckInput, identity: string, checkSignal = signal): Promise<readonly DailyCheckRun[]> => {
    if (signal.aborted || checkSignal.aborted) return [];
    try {
      const result = await learning.check({ scope: input.scope, requirements: input.requirements, input: facts,
        runId: identity, sessionId: input.sessionId, turnId: input.turnId }, checkSignal);
      if (!result.ok) {
        warn(result.code);
        return [];
      }
      for (const run of result.runs) if (!priorRuns.includes(run.runId)) priorRuns.push(run.runId);
      while (priorRuns.length > 32) priorRuns.shift();
      return result.runs;
    } catch {
      warn("checker_execution_unavailable");
      return [];
    }
  };
  const capture = async (facts: CheckInput, identity: string): Promise<void> => {
    if (signal.aborted) return;
    try {
      const assessment = input.assess(input.requirements, facts);
      const experience: CheckExperience = { schemaVersion: 2, type: "check_experience", id: `check-experience:${contentHashOf([identity, facts])}`,
        scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, requirements: input.requirements,
        facts, priorRuns: [...priorRuns], ...(assessment === undefined ? {} : { assessment }) };
      const saved = await learning.capture(experience);
      if (!saved.ok) warn(saved.code);
    }
    catch { warn("experience_write_unavailable"); }
  };
  const drain = async (batchSignal: AbortSignal): Promise<void> => {
    const selected = pending.splice(0, 3), runs: DailyCheckRun[] = [];

    for (const [index, item] of selected.entries()) {
      if (batchSignal.aborted || signal.aborted) return;

      const later = [...selected.slice(index + 1), ...pending];
      if (item.paths.some(file => later.some(next => next.paths.some(other => input.artifacts.same(file, other))))) {
        warn("artifact_superseded_before_check");
        await capture(item.facts, item.identity);
        continue;
      }

      const output = item.paths.length === 0 ? undefined : await input.artifacts.read(item.paths, batchSignal);
      if (item.paths.length > 0 && output === undefined) {
        await capture(item.facts, item.identity);
        continue;
      }

      const parsed = parseCheckInput(output === undefined ? item.facts : { ...item.facts, output });
      if (!parsed.ok) {
        warn(parsed.code);
        await capture(item.facts, item.identity);
        continue;
      }

      runs.push(...await check(parsed.value, item.identity, batchSignal));
      await capture(parsed.value, item.identity);
    }

    if (runs.length > 0) feedback = formatRuns(runs);
  };
  const provider = input.ports.provider;
  const checkedProvider: ProviderPort = { ...provider,
    async *stream(request, streamSignal) {
      await drain(streamSignal);
      const text = feedback;
      feedback = "";
      const message = text.length === 0 ? undefined : { role: "system" as const,
        content: `Actual learned-check execution results follow as task evidence. Preserve the frozen requirements and permission rules. A checker error is not an object defect.\n${text}` };
      const messages = message === undefined ? request.messages : [...request.messages, message];
      const next: ProviderRequest = input.contextTokenLimit !== undefined
        && estimateMessagesTokens(messages) + (request.maxOutputTokens ?? 0) > input.contextTokenLimit ? request : { ...request, messages };
      if (message !== undefined && next === request) warn("check_feedback_context_capacity");

      yield* provider.stream(next, streamSignal);
    },
  };
  const ports: LoopPorts = { ...input.ports, provider: checkedProvider, tools: {
    snapshot: () => tools.snapshot(), cancel: id => tools.cancel(id),
    async execute(call, toolSignal) {
      const result = await tools.execute(call, toolSignal);

      if (toolSignal.aborted || signal.aborted) return result;

      const facts = toolFacts(input, input.requirements, call, result);
      if (!facts.ok) {
        warn(facts.code);
        return result;
      }

      const identity = `execution:check:${input.sessionId}:${input.turnId}:${call.toolCallId}`;

      // Enqueue only. A slow checker must not turn an already committed write into a tool timeout or unknown outcome.
      if (pending.length >= 16) warn("check_pending_capacity");
      else pending.push({ facts: facts.value, identity, paths: result.outcome === "result"
        ? readFileWriteRecords(call.toolCallId, call.name, result.value).filter(record => record.effect.mode !== "deleted").map(record => record.effect.path) : [] });

      return result;
    },
  } };

  return {
    ports,
    capture(event: Envelope): void {
      if (event.sessionId !== input.sessionId || event.turnId !== input.turnId || event.kind !== "user_correction") return;
      if (typeof event.payload.text !== "string" || event.payload.text.length > 8192 || corrections.length >= 16) return;
      if (!corrections.some(previous => previous.eventId === event.eventId)) corrections.push(event);
    },
    async finish(result: RunTurnResult): Promise<void> {
      if (signal.aborted) return;

      await drain(signal);

      if (result.state.terminalReason !== "completed") return;

      const lastPriorSequence = input.resumeTranscript?.at(-1)?.sequence ?? -1;
      const lastToolSequence = result.transcript.filter(item => item.kind === "tool_result").at(-1)?.sequence ?? -1;
      const finalText = result.transcript.flatMap(item => item.kind === "assistant_text"
        && item.sequence > Math.max(lastPriorSequence, lastToolSequence) ? [item.text] : []).join("\n");
      const facts = parseCheckInput({ task: taskIdentity(input, input.requirements), phase: "before_completion", output: jsonOutput(finalText) });
      if (!facts.ok) warn(facts.code);
      else {
        const identity = `execution:check:${input.sessionId}:${input.turnId}:completion`;
        const runs = await check(facts.value, identity);
        await capture(facts.value, identity);
        if (runs.length > 0) input.publishResult(formatRuns(runs));
      }

      for (const correction of corrections) {
        if (signal.aborted || learning.feedback === undefined) break;
        try {
          const recorded = await learning.feedback({ scope: input.scope, sessionId: input.sessionId, turnId: input.turnId,
            sourceRef: `execution:${correction.eventId}`, text: String(correction.payload.text), runIds: [...priorRuns] }, signal);
          if (!recorded.ok) warn(recorded.code);
        } catch { warn("feedback_write_unavailable"); }
      }
    },
    async afterClose(): Promise<void> {
      input.beginLearning();

      if (signal.aborted) return;

      try {
        // Preserve queued experiences without silently moving a timing-sensitive check to a later boundary.
        if (pending.length > 0) warn("pending_check_not_executed");

        for (const item of pending.splice(0)) await capture(item.facts, item.identity);

        // Task completion must not open a fresh execution approval. Independent learning can validate in its own explicit call.
        if (allowance.executions > 0) warn("validation_deferred_to_independent_learning");

        const result = await learning.learn({ subsystem: "verifier", allowance: { ...allowance, executions: 0 } }, signal);
        if (!result.ok) warn(result.code);
      } catch { warn("learning_unavailable"); }
    },
  };

}
