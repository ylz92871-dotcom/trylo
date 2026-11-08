import { emptyUsage, mergeUsage, type ProviderPort } from "../../../../../ports/provider.js";
import type { CollaborationDecisionPort } from "../orchestration/contracts.js";
import { LEARNING_RESPONSE_FAILURE } from "../orchestration/contracts.js";
import { isLearningAction } from "../orchestration/parse.js";
import { systemTimerScheduler, type TimerScheduler } from "../../../../../subagent/scheduler.js";
import { COLLABORATION_TIMING } from "../control/timing.js";
import { createSourceHandles, expandActionSourceHandles } from "./source-handles.js";
import { COLLABORATION_EVALUATION_LIMITS as EVALUATION_LIMITS } from "../domain/evaluation.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../../../../protocol/collaboration-resource.js";
import { learningUsageSettlement, type LearningUsageBoundary } from "../../../../control/usage-settlement.js";

const INSTRUCTIONS = `You are Trylo's bounded collaboration-learning loop. Personal Agent has already focused this issue.
focused_learning is PA's routing decision to investigate the reported issue under this existing central grant. It does not mean the issue is resolved, a fix is implemented or validated, or a reusable practice or experience already exists.
centralContent, when supplied, is the source-bound question, original requirements and existing-answer analysis. Use its stated conditions while investigating; it is input data, not a verifier verdict, observed benefit or additional permission.
Evaluate the reported facts and current observations. Query the existing resources when a specific missing fact or resource is needed. Return no_change only for an evidence-based lack of an actionable reusable change or genuinely insufficient evidence; the focus decision or selection of an expert alone is never evidence of resolution.
You do not run business tasks, approve creation, schedule a team, or grant permissions. Read facts separately from suspected causes.
Investigate whether coordination, responsibilities, handoff, synchronisation or review explains the evidence; do not blame member capability without evidence.
Choose the content and next steps yourself. Query existing tools/experts/experience first when relevant. Prefer reuse. Research may consult authorized official/community resources.
Return one JSON action only:
{"kind":"query","owner":"tool|expert|experience|research","query":"specific resource question"}
Each query must be non-empty and at most ${COLLABORATION_RESOURCE_LIMITS.queryMaxChars} characters so it fits the actual resource receipt contract; shorten the question before querying rather than truncating source references.
or {"kind":"propose","familyId":"stable-problem-family","title":"specific improvement","summary":"evidence and remaining uncertainty","sourceRefs":["actual refs"],
"adjustments":[{"memberId":"actual member id or personal_agent","kind":"division|handoff|sharing|review|configuration","instruction":"concrete practice","expertSelection":{"expertId":"actual id","version":1}}],
"experiences":[{"ownerRef":"actual context owner ref","familyId":"family","situation":"applicable situation","responsibilities":["relevant duty"],"practice":"specific reusable instruction","sourceRefs":["actual refs"],"conditions":{},"parentVersion":"only actual predecessor if revising"}],
"needs":[{"owner":"tool|expert","memberId":"actual target","instruction":"precise unmet capability and why reuse is insufficient","expertId":"optional real existing expert id when revising its configuration"}]}
or {"kind":"no_change","reason":"specific reason to return to Personal Agent","sourceRefs":["actual refs"]}.
For propose, adjustments, experiences and needs are all required arrays. Use [] when a category has no items; never omit it. At least one of these arrays must contain a concrete item; otherwise return no_change.
Omit optional fields when unknown. Do not invent identities, sources, outcomes, URLs or approvals. A trial is not proven effective.
sourceHandles is a private table for this request only. Prefer its exact short handles (R1, R2, etc.) in sourceRefs and experiences[].parentVersion instead of copying long IDs. Full canonical IDs are also accepted. Never shorten a hash, omit an ID prefix or invent a handle. Handles identify source references only: never substitute them for ownerRef, memberId, expertId, titles, instructions or other fields.
Each experience belongs to exactly the supplied stable ownerRef. Give each relevant member only its own practice; PA planning belongs to personal_agent.
Experience cards including situation, duties and practice must fit 600 characters. Use narrow known conditions, not unknown placeholders.
Experience conditions are optional: include only keys and values explicitly supplied as actual runtime retrieval context. Add surface only when its code or work value is actually known. If only surface and useScope are supplied, do not add taskFamily or dependency. A problemKey, issue/report label, role or task prose is not a trusted runtime taskFamily or dependency; do not derive or guess these values. Missing or unknown context means omit that condition, not fill a template or write unknown.
For a practice that depends on a specific expert configuration, experience.expertVersion may pin the actual supplied identity.version. Omit it for stable-owner experience across configuration revisions; do not supply it for PA or legacy-member owners. The host checks it against the real library identity.
If a trusted owner retrievalContext supplies responsibilities, conditions.responsibility may use one exact supplied key. Do not turn an omitted or overlong role description into a guessed or shortened matching key.
If observations contain validationFeedback, generate a new action under this same original schema. This is a normal next step within the remaining original grant, not permission for another job, grant or critic.
Needs are proposals for PA consent, never permission to create. Expert selection is optional and must refer to real query results.
Avoid generic advice such as communicate better; specify handoff artifacts, pending work, dependencies, synchronisation trigger, ownership or review boundary.
For a new reusable change, include evaluation on the proposal and on each relevant experience. It is a trial hypothesis, not an effectiveness verdict:
{"schema":"collaboration-evaluation/v1","mechanism":"why this specific change may address the observed problem",
"alternatives":[{"explanation":"another plausible cause","discriminator":"what actual observation would distinguish it"}],
"expectedObservations":[{"id":"stable-short-id","observation":"what the affected member or receiver should actually do at the next relevant opportunity"}],
"reconsiderWhen":["a concrete contrary observation or different prerequisite requiring PA review"]}.
Use at most ${EVALUATION_LIMITS.mechanismChars} characters for mechanism; ${EVALUATION_LIMITS.alternatives} alternatives, each explanation/discriminator at most ${EVALUATION_LIMITS.explanationChars}/${EVALUATION_LIMITS.observationChars} characters; ${EVALUATION_LIMITS.observations} expectedObservations with unique IDs (at most ${EVALUATION_LIMITS.observationIdChars} chars) and observations at most ${EVALUATION_LIMITS.observationChars} chars; ${EVALUATION_LIMITS.reconsiderConditions} reconsiderWhen entries at most ${EVALUATION_LIMITS.observationChars} chars each. Each array must be nonempty.
Observe actual handoff acceptance, tool or file effects, avoided rework, or changed division/sharing/configuration at a real boundary; a fluent report, completed task or guidance exposure alone is insufficient.
Existing trialHistory contains frozen hypotheses and real use/feedback claims. Distinguish a defective practice from a practice used in an unsuitable context. Uncertain attribution remains uncertain; do not globally replace a practice because one exception failed. Revise only the part and scope supported by actual reports and their sources.
Recovered research history preserves completed queries from this same original grant. Continue from those actual observations rather than repeating a completed query merely because the worker was resumed. A historical preview is not present capability admission; request a new lookup only when a concrete new fact or changed availability makes it necessary.
Evaluation metadata belongs to its actual owner and version; do not distribute every member's learning to all members. Retain narrow known runtime conditions, and put essential behavioral constraints in the short practice itself.`;

/** Isolated provider adapter; every paid attempt reserves and settles the original central grant. */
export function createCollaborationDecisionModel(options: { readonly provider: ProviderPort; readonly model: string;
  readonly maxOutputTokens?: number;
  readonly enabled?: () => boolean; readonly timeoutMs?: number; readonly scheduler?: TimerScheduler }): CollaborationDecisionPort {
  return { async decide(input) {
    const failed = (reason: string) => ({ ok: false as const, reason });
    // The original work signal supplies the actual remaining deadline; a local abort is no remote cancellation receipt.
    const timeoutMs = options.timeoutMs ?? COLLABORATION_TIMING.maxWorkMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > COLLABORATION_TIMING.maxWorkMs) return failed("learning_timing_invalid");

    const state = await input.funding.inspect();
    if (!state.ok || !state.active || options.enabled?.() === false) return failed("learning_inactive");

    const sourceHandles = createSourceHandles(input.knownSourceRefs);
    const material = JSON.stringify({ issue: input.issue, material: input.material, sourceHandles });
    const prompt = INSTRUCTIONS + material;
    if (prompt.length > input.maxPromptChars) return failed("learning_prompt_limit");

    const inputReservation = Math.ceil(new TextEncoder().encode(prompt).length / 2) + 256;
    const availableOutputTokens = state.remaining.tokens - inputReservation;
    const maxOutputTokens = Math.min(options.maxOutputTokens ?? availableOutputTokens, availableOutputTokens);
    if (maxOutputTokens < 256 || state.remaining.calls < 1 || state.remaining.steps < 1) return failed("learning_budget_exhausted");

    const provider = options.provider.fork?.([]);
    if (!provider || provider === options.provider) return failed("learning_provider_isolation_unavailable");

    const reservationId = `collaboration-decision:${input.claimId}:${input.step}`;
    const reserved = await input.funding.reserve({ reservationId, maxTokens: inputReservation + maxOutputTokens });
    if (!reserved.ok) return failed(reserved.reason);

    if (reserved.status === "duplicate") return failed("learning_call_already_reserved");

    let usage = emptyUsage(), reported = false, output = "", completed = false, timedOut = false, reason: string | undefined;
    let usageTailIncomplete = false;
    const controller = new AbortController();
    const abort = () => controller.abort();

    input.signal.addEventListener("abort", abort, { once: true });
    const timer = (options.scheduler ?? systemTimerScheduler)(timeoutMs, () => {
      timedOut = true;
      controller.abort("learning_model_timeout");
    });

    try {
      if (input.signal.aborted) controller.abort();

      for await (const event of provider.stream({ attemptId: reservationId, continuationScope: input.jobId, model: options.model,
        maxOutputTokens, tools: [], messages: [{ role: "system", content: INSTRUCTIONS }, { role: "user", content: material }] }, controller.signal)) {
        if (event.type === "usage") {
          if (![event.usage.inputTokens, event.usage.outputTokens, event.usage.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
            reason = "learning_usage_invalid";
            controller.abort();
            break;
          }
          usage = mergeUsage(usage, event.usage);
          reported = usage.totalTokens > 0;
          if (usage.totalTokens > inputReservation + maxOutputTokens) {
            reason = "learning_provider_exceeded_reservation";
            controller.abort();
            break;
          }
        }

        if (event.type === "warning" && event.code === "stream_finish_tail_timeout") usageTailIncomplete = true;

        if (input.signal.aborted || options.enabled?.() === false) {
          reason = "learning_inactive";
          controller.abort();
          break;
        }

        if (event.type === "text_delta") output += event.text;

        if (output.length > 65536) {
          reason = "learning_output_limit";
          controller.abort();
          break;
        }

        if (event.type === "error") {
          reason = timedOut ? "learning_model_timeout" : `learning_provider_${event.class}`;
          break;
        }

        if (["tool_call", "tool_call_invalid", "tool_input_start"].includes(event.type)) {
          reason = "learning_model_tool_forbidden";
          controller.abort();
          break;
        }

        if (event.type === "finish") {
          completed = event.reason === "stop" && !event.requiresFollowUp;
          if (!completed) reason ??= event.reason === "length" ? "learning_model_output_truncated"
            : event.requiresFollowUp ? "learning_model_follow_up_required" : `learning_model_finish_${event.reason}`;
        }
      }

      if (controller.signal.aborted || !completed) reason ??= timedOut ? "learning_model_timeout" : "learning_model_incomplete";
    } catch {
      reason ??= input.signal.aborted ? "learning_aborted" : timedOut ? "learning_model_timeout" : "learning_provider_unavailable";
    } finally {
      timer.cancel();
      input.signal.removeEventListener("abort", abort);
      controller.abort();
    }

    const boundary: LearningUsageBoundary = usage.totalTokens > inputReservation + maxOutputTokens ? { kind: "overrun" }
      : completed && reason === undefined && !input.signal.aborted && !usageTailIncomplete ? { kind: "complete" }
      : { kind: "unknown", reason: reason ?? (usageTailIncomplete ? "provider_usage_tail_incomplete" : "provider_usage_absent") };
    const settled = await input.funding.settle({ reservationId, usage: learningUsageSettlement(boundary, reported
      ? { totalTokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: options.model } : undefined) });
    if (!settled.ok) return failed(settled.reason);

    if (reason) return failed(reason);

    try {
      const value = expandActionSourceHandles(JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1")), sourceHandles);
      return isLearningAction(value) ? { ok: true, action: value } : failed(LEARNING_RESPONSE_FAILURE.action);
    } catch { return failed(LEARNING_RESPONSE_FAILURE.json); }
  } };
}
