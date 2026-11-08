import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { isJsonValue, keysAre, recordOf } from "../domain/evolution/parse.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { readNpmLearningArtifact, saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { checkNpmSourceImplementation, decodeNpmSourceCheck, npmSourceExecutionUnavailable, type NpmSourceCheck } from "./npm-source-check.js";
import { saveToolProductionPlan } from "./production-assets.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { npmBaselineCandidate, type NpmBaselineStrategy } from "./npm-baseline-candidate.js";

type BaselineFeedback = { readonly type: "tool_npm_upstream_baseline"; readonly schemaVersion: 1;
  readonly subjectId: string; readonly parentVersionId: string; readonly installationId: string; readonly checksHash: string;
  readonly strategy: NpmBaselineStrategy;
  readonly candidateSpecHash: string; readonly attempt: number; readonly check: NpmSourceCheck };

type Outcome = PipelineFailure | { readonly kind: "not_applicable" }
  | { readonly kind: "prepared"; readonly ok: true; readonly versionId: string; readonly sourceChecked: true }
  | { readonly kind: "diagnostic"; readonly feedback: BaselineFeedback };

/** Reuse source only for a clean upstream or an explicitly corrected oracle.
 * Ordinary feedback must still construct an implementation, even if old source cases pass. */
export async function prepareNpmUpstreamBaseline(input: NpmAdaptationInput, checks: ToolEvolutionRequest, contractId?: string): Promise<Outcome> {
  const selected = await npmBaselineCandidate(input, checks, contractId);
  if ("ok" in selected || selected.kind === "not_applicable") return selected;

  const { candidate, strategy, parentVersionId } = selected;
  const { learning: _learning, ...candidateSpec } = candidate;
  const { requestId: _trace, ...evolutionSpec } = candidateSpec.evolution!;
  const identity = { subjectId: input.admission.jobId, parentVersionId, installationId: npmInstallId(input.installation), strategy,
    checksHash: contentHashOf(checks), candidateSpecHash: contentHashOf({ ...candidateSpec, evolution: evolutionSpec }) };
  const versionId = `npm-upstream-baseline_v1_${contentHashOf(identity)}`;
  const durable = await readNpmLearningArtifact(input.boardRoot, versionId, input.plan.scope);
  if (!durable.ok) return durable;

  const attemptVersionId = `${versionId}:attempt:${input.admission.attempt}`;
  const stored = durable.content === undefined ? await readNpmLearningArtifact(input.boardRoot, attemptVersionId, input.plan.scope) : durable;
  if (!stored.ok) return stored;

  let feedback: BaselineFeedback;

  if (stored.content !== undefined) {
    const raw = stored.content;
    const check = recordOf(raw) ? decodeNpmSourceCheck(raw.check, candidate) : undefined;
    if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["type", "schemaVersion", ...Object.keys(identity), "attempt", "check"])
      || raw.type !== "tool_npm_upstream_baseline" || raw.schemaVersion !== 1 || check === undefined
      || typeof raw.attempt !== "number" || !Number.isSafeInteger(raw.attempt) || raw.attempt < 1
      || (check.kind === "blocked" && raw.attempt !== input.admission.attempt)
      || Object.entries(identity).some(([key, value]) => raw[key] !== value)) return pipelineFailure("invalid_upstream_baseline_record", versionId);

    feedback = { type: "tool_npm_upstream_baseline", schemaVersion: 1, ...identity, attempt: raw.attempt, check };
  } else {
    if (input.signal.aborted) return pipelineFailure("cancelled", identity.subjectId);

    const check = input.services.execute === undefined
      ? npmSourceExecutionUnavailable()
      : await checkNpmSourceImplementation(candidate, input.services.execute, input.signal);

    if (input.signal.aborted) return pipelineFailure("cancelled", identity.subjectId);

    feedback = { type: "tool_npm_upstream_baseline", schemaVersion: 1, ...identity, attempt: input.admission.attempt, check };
    // A new explicit claim may gain execution authority or a ready OS fence. Source failures/passes
    // remain tied to bytes/checks; temporary execution blockers are cached only for this claim.
    const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope,
      versionId: check.kind === "blocked" ? attemptVersionId : versionId, content: feedback, issuedAt: new Date(input.now()).toISOString() });
    if (!saved.ok) return saved;
  }

  if (feedback.check.kind !== "passed") return { kind: "diagnostic", feedback };

  if (input.signal.aborted) return pipelineFailure("cancelled", identity.subjectId);

  const saved = await saveToolProductionPlan(input.boardRoot, candidate, new Date(input.now()).toISOString(), input.admission);

  return saved.ok ? { kind: "prepared", ok: true, versionId: saved.versionId, sourceChecked: true } : saved;
}
