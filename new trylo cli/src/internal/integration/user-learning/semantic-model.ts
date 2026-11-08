import type { ProviderPort } from "../../ports/provider.js";
import type { UserEvidence } from "../../learning/domains/user/contracts.js";
import type { UserLearningProgress, UserLearningVersion } from "../../learning/domains/user/learning-cycle-contract.js";
import { readUserSemanticDraft, type UserSemanticDraft } from "../../learning/domains/user/semantic-draft.js";
import { POLICY_DIMENSIONS, ELIGIBILITY_CLASSES } from "../../learning/domains/user/contracts.js";
import { readContentModelStream } from "../learning-content/model-stream.js";
import type { CentralAccountingFundingPort } from "../learning-content/central-accounting-funding.js";
import { learningUsageSettlement } from "../../learning/control/usage-settlement.js";
import { sha256Hex } from "../../learning/domains/shared/hash.js";
import { userModelFailure, type UserModelFailure } from "./model-failure.js";

const INSTRUCTION = `You are Trylo's private User Learning peer, separate from its business agent.
Learn professional collaboration judgments from authentic user evidence. Preserve Evidence -> Eligibility -> Conclusion -> User Model -> Policy distinctions.
First decide which evidence is a durable preference among valid alternatives. Quality defects, truth/correctness requirements, permissions and task-only commands are not preferences.
Durability and signalKind are collection hints, not proof of a preference. A personalization_candidate needs a user choice between two independently acceptable ways of working; explain that contrast in its rationale. An incorrect implementation is never an acceptable alternative. A lasting requirement may still be general_quality_defect.
For example, reading the current receiver contract rather than applying an incompatible case's units, checking a parsed value before property access, preserving actual exit codes, and reporting local validation separately from remote acceptance are ordinary correctness, not personal preferences. A preference could instead concern which of two correct explanations to present first or how to organize a correct deliverable. A result with no personal policies is valid.
Compare conditions, contradictions, alternative explanations, and prior feedback. Current user instructions override all historical policy.
Do not invent evidence, confirmation, successful usage, tools or permissions. Model output is inference, not a user's explicit instruction. Do not describe personality.
You can continue an unfinished comparison on the same evidence, revise a hypothesis, complete a useful policy, or ask a specific necessary clarification.
An unanswered question or absent real-use feedback requires waiting, not another paraphrase. progress.nextAction must name a concrete unfinished computation when continuing.
Produce a LOCAL update from the supplied recent evidence/context. Prior valid conclusions/models/policies persist unless a grounded explicit policyRevisions entry targets one rule.
Never erase old knowledge because its raw support is outside this bounded page. Cite prior immutable versions for comparison and request missing raw evidence when essential.
When explicitly reconsidering a prior version, reassess its original support. Reclassifying supplied support as correctness/task/permission evidence corrects an inferred hypothesis; it is not a new human withdrawal. Do not preserve an unsupported inference merely because it was previously saved. Source reclassification removes its unsupported inference chain; policyRevisions remains for actual explicit user changes.
Generic dissatisfaction, mathematical errors or artifact defects do NOT attribute failure to every exposed policy. A policyRevisions pause/replace requires the user's specific explicit withdrawal/change of that policy with a verbatim quote; otherwise keep observation and seek clarification.
Do not treat speaking about permissions as permission expansion: e.g. explain reasons/alternatives before a permission request is a communication preference while Permission still owns the decision. No fixed two decision-point limit.
All conclusions must cite supplied eligible evidence IDs; models cite conclusion keys; policies cite modelKey and source evidence IDs.
Policies are reversible prompt advice with explicit applicability and literal includeTerms/excludeTerms for deterministic selection. Empty includeTerms means all tasks in this workspace, only if justified.
Return only JSON:
{"schemaVersion":1,"eligibility":[{"evidenceId":"id","classification":"class","rationale":"why"}],
"conclusions":[{"key":"key","statement":"pattern","dimension":"dimension","evidenceIds":["id"],"counterEvidenceIds":[],"conditions":"boundary"}],
"models":[{"key":"key","conclusionKeys":["key"],"statement":"professional collaboration judgment","distance":"D0|D1|D2","alternatives":["alternative"]}],
"policies":[{"modelKey":"key","instruction":"concrete reversible behavior","applicability":"when and when not","includeTerms":[],"excludeTerms":[],"evidenceIds":["id"]}],
"policyRevisions":[{"ruleId":"original rule id","action":"pause|replace","evidenceId":"user source id","quote":"specific explicit user policy-change span","reason":"why this rule is specifically targeted"}],
"progress":{"state":"continue|clarification|completed|no_result","understanding":"public work result","remaining":"remaining uncertainty","nextAction":"concrete computation or empty","clarification":null}}
Allowed dimensions: ${POLICY_DIMENSIONS.join(", ")}.
Allowed eligibility classes: ${ELIGIBILITY_CLASSES.join(", ")}.`;

export type UserSemanticModelDeps = { readonly provider: ProviderPort; readonly model: string;
  /** Optional verified provider or explicit host generation allowance. */
  readonly maxOutputTokens?: number;
  readonly funding: CentralAccountingFundingPort; readonly enabled: () => boolean };

type UserSemanticResult = UserModelFailure | { readonly ok: true; readonly draft: UserSemanticDraft;
  readonly chargedTokens: number; readonly responseRef: string };

/** One private, tool-free call. The actual provider's usage tail, not JSON success, settles the root. */
export async function runUserSemanticModel(deps: UserSemanticModelDeps, input: { readonly reservationId: string;
  readonly purpose: string; readonly evidence: readonly UserEvidence[]; readonly feedback: readonly unknown[];
  readonly reconsiderVersionRef?: string;
  readonly previous?: UserLearningVersion; readonly progress?: UserLearningProgress; readonly maxTokens: number;
  readonly maxPromptChars?: number; readonly expectedSequence: number }, signal: AbortSignal): Promise<UserSemanticResult> {
  const provider = deps.provider.fork?.([]);
  if (provider === undefined || provider === deps.provider) return { ok: false as const, reason: "user_learning_provider_isolation_unavailable" };

  const messages = [{ role: "system" as const, content: INSTRUCTION }, { role: "user" as const,
    content: JSON.stringify({ purpose: input.purpose, reconsiderVersionRef: input.reconsiderVersionRef, evidence: input.evidence.map(item => ({ id: item.id, rawText: item.rawText,
      eventKind: item.eventKind, durability: item.durability, signalKind: item.signalKind, source: item.source })), feedback: input.feedback,
      previous: input.previous === undefined ? undefined : { versionId: input.previous.versionId,
        conclusions: input.previous.conclusions.map(item => ({ id: item.id, statement: item.statement, supporting: item.supporting, counter: item.counter })),
        models: input.previous.models.map(item => ({ id: item.id, statement: item.statement, distance: item.distance, alternativeExplanations: item.alternativeExplanations })),
        policies: input.previous.policies }, progress: input.progress }) }];
  const promptBytes = new TextEncoder().encode(JSON.stringify({ messages, tools: [] })).length;

  if (input.maxPromptChars !== undefined && JSON.stringify({ messages, tools: [] }).length > input.maxPromptChars) {
    return userModelFailure("user_learning_prompt_envelope_exceeded");
  }

  const overhead = provider.continuation?.estimateOverheadTokens?.(messages) ?? 0;
  if (!Number.isSafeInteger(overhead) || overhead < 0) return { ok: false as const, reason: "user_learning_overhead_invalid" };

  // Byte upper reserve is deliberately conservative; it is never reported as measured usage.
  const availableOutput = input.maxTokens - promptBytes - overhead - 512;
  const output = deps.maxOutputTokens === undefined ? availableOutput : Math.min(deps.maxOutputTokens, availableOutput);
  if (!Number.isSafeInteger(output)) return userModelFailure("user_learning_output_allowance_invalid");

  if (output < 256) return userModelFailure("user_learning_prompt_budget_exhausted");

  if (signal.aborted || !deps.enabled()) return { ok: false as const, reason: "collect_disabled_or_cancelled" };

  const reserved = await deps.funding.reserve({ reservationId: input.reservationId, maxTokens: input.maxTokens, expectedSequence: input.expectedSequence });
  if (!reserved.ok) return userModelFailure(reserved.reason, [input.reservationId]);

  if (reserved.status !== "reserved") return userModelFailure("user_learning_request_already_reserved", [input.reservationId]);

  const response = await readContentModelStream({ provider, request: { attemptId: input.reservationId,
    model: deps.model, messages, tools: [], maxOutputTokens: output,
    ...(provider.responseFormats?.includes("json_object") ? { responseFormat: { type: "json_object" as const } } : {}) }, maxTokens: input.maxTokens,
    signal, enabled: deps.enabled });
  const settled = await deps.funding.settle({ reservationId: input.reservationId,
    usage: learningUsageSettlement(response.boundary, response.reported ? { totalTokens: response.usage.totalTokens,
      inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, model: deps.model } : undefined) });
  if (!settled.ok) return userModelFailure("user_learning_settlement_unconfirmed", [input.reservationId]);

  if (response.reason !== undefined) return userModelFailure(response.reason, [input.reservationId]);

  if (signal.aborted || !deps.enabled()) return { ok: false as const, reason: "collect_disabled_or_cancelled" };

  let parsed: unknown;

  try { parsed = JSON.parse(response.text); }
  catch { return { ok: false as const, reason: "user_learning_response_json_invalid" }; }

  const draft = readUserSemanticDraft(parsed);

  return draft === undefined ? { ok: false as const, reason: "user_learning_response_invalid" }
    : { ok: true as const, draft, chargedTokens: response.boundary.kind === "complete" && response.reported
      ? response.usage.totalTokens : input.maxTokens, responseRef: `user-response:${sha256Hex(response.text)}` };
}
