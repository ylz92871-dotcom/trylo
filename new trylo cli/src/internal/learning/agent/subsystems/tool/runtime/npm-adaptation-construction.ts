import { contentHashOf } from "../../../../control/hash.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface, type NpmToolInterface } from "../domain/evolution/npm-production-plan.js";
import type { NpmLearningContract } from "../domain/evolution/npm-learning.js";
import { decodeNpmSourceRead, type NpmSourceRead } from "../domain/evolution/npm-learning.js";
import { npmImplementationPrompt } from "../domain/evolution/npm-learning-prompt.js";
import { recordOf } from "../domain/evolution/parse.js";
import type { PackageFile } from "../adapters/acquisition/ustar-reader.js";
import { npmLearningSource, mergeNpmLearningSource, npmLearningSourceFingerprint } from "../adapters/acquisition/npm-learning-source.js";
import { fitNpmLearningResearchPrompt } from "../adapters/acquisition/npm-learning-research-budget.js";
import { npmLearningPrior } from "../adapters/acquisition/npm-learning-prior.js";
import { resolveNpmInterfaceSourceEdits } from "../adapters/acquisition/npm-interface-source-edits.js";
import { readNpmLearningProgress, saveNpmLearningSourceRead } from "./npm-learning-progress.js";
import { checkNpmSourceImplementation } from "./npm-source-check.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { saveToolProductionPlan } from "./production-assets.js";
import { isNpmLearningDeferral, saveNpmLearningDeferral } from "./npm-adaptation-contract.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import type { NpmAdaptationInput as Input } from "./npm-adaptation-types.js";
import { npmAdaptationEvolution, npmAdaptationParent, npmAdaptationPrior } from "./npm-adaptation-parent.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";
import { readNpmConstructionResearchBoundary, closeNpmConstructionResearch } from "./npm-construction-research.js";

type Facts = { readonly files: readonly PackageFile[]; readonly contract: NpmLearningContract; readonly contractId: string;
  readonly source: ReturnType<typeof npmLearningSource>; readonly baselineFeedback?: unknown };

type Construction = { researchFiles: readonly PackageFile[]; source: ReturnType<typeof npmLearningSource>;
  previous: unknown; feedback: unknown; latestSource: string | undefined; readonly reads: Set<string>; sourceReadsClosed: boolean; researchFocus: string;
  failedImplementationHash?: string };

type Outcome = PipelineFailure | { readonly ok: true; readonly versionId: string; readonly sourceChecked: boolean };

/** All mutable work here is ephemeral; committed contract, observations and candidates remain on Board. */
export async function constructNpmLearningTool(input: Input, facts: Facts): Promise<Outcome> {
  if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

  const restored = await restoreConstruction(input, facts);
  if (!restored.ok) return restored;

  if ("outcome" in restored) return restored.outcome;

  const state = restored.state;

  for (let step = 0; step < 8; step++) {
    const allowance = await input.services.allowance();
    if (allowance === undefined || allowance.callsRemaining < 1 || allowance.tokensRemaining < 1) return pipelineFailure("learning_budget_exhausted", "The original task's central allowance is exhausted");

    state.sourceReadsClosed ||= allowance.callsRemaining <= 1;
    const prompt = fitNpmLearningResearchPrompt(state.source, input.researchReferences, (source, researchReferences) => npmImplementationPrompt({ contract: facts.contract, adaptation: input.adaptation, source,
      previous: state.previous, feedback: state.feedback, allowance, sourceReadsClosed: state.sourceReadsClosed,
      ...(researchReferences === undefined ? {} : { researchReferences }),
      ...(npmAdaptationParent(input) === undefined ? {} : { parentFeedback: npmAdaptationParent(input)!.feedback.slice(0, 8_000) }) }), allowance.maxPromptChars);
    if (prompt === undefined) return pipelineFailure("npm_implementation_context_exceeds_allowance", "The frozen construction contract exceeds the central prompt allowance");

    let raw: unknown;

    try { raw = await input.services.complete(prompt, input.signal, "implementation"); }
    catch (error) { return pipelineFailure(input.signal.aborted ? "cancelled" : error instanceof ToolLearningServiceError ? error.code : "npm_adaptation_service_failed",
      "The centrally funded implementation decision did not complete"); }

    if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

    if (isNpmLearningDeferral(raw)) return saveNpmLearningDeferral(input, raw);

    const read = decodeNpmSourceRead(raw);
    if (read !== undefined) {
      const inspected = await readConstructionSource(input, facts, state, read);
      if (!inspected.ok) return inspected;
      continue;
    }

    const resolved = recordOf(raw) && raw.action === "candidate" ? resolveNpmInterfaceSourceEdits(raw.interface, facts.files,
      [state.latestSource, input.parent?.plan.runtime.profile === "confined_npm_library_v1" ? input.parent.plan.runtime.source : input.predecessor?.source]
        .filter((value): value is string => value !== undefined)) : undefined;
    if (resolved !== undefined && !resolved.ok) return resolved;

    const selected = resolved?.ok ? decodeNpmToolInterface(resolved.interface) : undefined;
    if (selected === undefined) return pipelineFailure("invalid_npm_adaptation", "Expected an explicit reviewed-package interface");

    if (state.failedImplementationHash === implementationHash(selected)) return pipelineFailure("npm_implementation_no_progress",
      "The same implementation already failed this frozen contract; changing its description is not a source repair");

    const attempt = await testConstruction(input, facts, selected);
    if (!attempt.ok) return attempt;

    if (attempt.check?.kind !== "failed") return publishConstruction(input, facts, selected, attempt.check?.kind === "passed");

    restoreAttemptSource(input, facts, state, attempt.plan, attempt.versionId);
    state.feedback = attempt.check;
  }

  return pipelineFailure("npm_adaptation_step_limit", "No new artifact after eight bounded implementation steps");
}

async function restoreConstruction(input: Input, facts: Facts) {
  const progress = await readNpmLearningProgress(input, facts.contractId, facts.contract.checks);
  if (!progress.ok) return progress;

  const prior = npmAdaptationPrior(input);
  const state: Construction = { researchFiles: [...facts.files, ...prior.files], source: facts.source, previous: prior.summary ?? null,
    feedback: facts.baselineFeedback ?? null, reads: new Set([npmLearningSourceFingerprint(facts.source)]), sourceReadsClosed: false,
    latestSource: input.parent?.plan.runtime.profile === "confined_npm_library_v1" ? input.parent.plan.runtime.source : undefined,
    researchFocus: `installation:${facts.contract.installationId}` };
  const last = progress.lastAttempt;
  if (last !== undefined) {
    if (last.check.kind !== "failed") return { ok: true as const, outcome: await publishConstruction(input, facts, last.interface, last.check.kind === "passed") };
    const plan = constructionPlan(input, facts, last.interface);
    if (plan === undefined) return pipelineFailure("invalid_npm_learning_attempt", last.versionId);
    restoreAttemptSource(input, facts, state, plan, last.versionId);
    state.feedback = last.check;
  }

  for (const read of progress.reads) {
    const view = npmLearningSource(state.researchFiles, input.installation.tree.root.location, read.request.paths, read.request.offset);
    const fingerprint = npmLearningSourceFingerprint(view);
    if (contentHashOf(fingerprint) !== read.sourceFingerprint) {
      if (!read.request.paths.some(file => file.startsWith("trylo_current/") || file.startsWith("trylo_attempt/"))) {
        return pipelineFailure("npm_implementation_source_changed", "Previously inspected immutable source coordinates no longer match their recorded content");
      }
      // A legacy mutable alias or a superseded failed attempt is not current evidence.
      // Keep the latest real source-check result; the new summary names exact paged source.
      continue;
    }

    state.reads.add(fingerprint);
    state.source = mergeNpmLearningSource(state.source, view);
  }

  const boundary = await readNpmConstructionResearchBoundary(input, facts.contractId, state.researchFocus);
  if (!boundary.ok) return boundary;

  state.sourceReadsClosed = boundary.closed;

  return { ok: true as const, state };
}

async function readConstructionSource(input: Input, facts: Facts, state: Construction, read: NpmSourceRead) {
  if (state.sourceReadsClosed) return pipelineFailure("npm_source_read_no_progress", "Source investigation is closed; choose an implementation or explain missing evidence");

  const view = npmLearningSource(state.researchFiles, input.installation.tree.root.location, read.paths, read.offset), fingerprint = npmLearningSourceFingerprint(view);
  if (state.reads.has(fingerprint)) {
    const closed = await closeNpmConstructionResearch(input, facts.contractId, state.researchFocus);
    if (!closed.ok) return closed;
    state.sourceReadsClosed = true;
    state.feedback = { kind: "source_investigation_closed", reason: "No new source information; make a final construction decision from the supplied evidence" };
    return { ok: true as const };
  }

  const saved = await saveNpmLearningSourceRead(input, { contractId: facts.contractId, request: read, sourceFingerprint: contentHashOf(fingerprint) });
  if (!saved.ok) return saved;

  state.reads.add(fingerprint);
  state.source = mergeNpmLearningSource(state.source, view);

  return { ok: true as const };
}

async function testConstruction(input: Input, facts: Facts, selected: NpmToolInterface) {
  const plan = constructionPlan(input, facts, selected);
  if (plan === undefined) return pipelineFailure("invalid_npm_production_plan", "The interface must bind the reviewed installation and frozen checks");

  const check = input.services.execute === undefined ? undefined : await checkNpmSourceImplementation(plan, input.services.execute, input.signal);

  if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

  const diagnostic = { type: "tool_npm_learning_attempt", schemaVersion: 1, subjectId: input.admission.jobId, contractId: facts.contractId,
    interface: selected, check: check ?? { kind: "not_run", reason: "execution_authorization_required" } };
  const versionId = `npm-attempt_v1_${contentHashOf(diagnostic)}`;
  const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId,
    content: diagnostic, issuedAt: new Date(input.now()).toISOString() });

  return saved.ok ? { ok: true as const, plan, check, versionId } : saved;
}

function attemptSourcePrefix(versionId: string): string { return `trylo_attempt/${versionId}`; }

function restoreAttemptSource(input: Input, facts: Facts, state: Construction, plan: NonNullable<ReturnType<typeof createNpmToolProductionPlan>>, versionId: string) {
  const current = npmLearningPrior(plan, attemptSourcePrefix(versionId));
  state.researchFiles = [...facts.files, ...npmAdaptationPrior(input).files, ...current.files];
  state.source = mergeNpmLearningSource(state.source, npmLearningSource(state.researchFiles, input.installation.tree.root.location));
  state.previous = current.summary;
  state.researchFocus = versionId;
  state.sourceReadsClosed = false;
  state.latestSource = plan.runtime.profile === "confined_npm_library_v1" ? plan.runtime.source : undefined;
  state.failedImplementationHash = implementationHash({ descriptor: plan.candidate, runtime: plan.runtime, ...(plan.patches === undefined ? {} : { patches: plan.patches }) });
}

function implementationHash(selected: NpmToolInterface): string { return contentHashOf({ runtime: selected.runtime, patches: selected.patches ?? [] }); }

function constructionPlan(input: Input, facts: Facts, selected: NpmToolInterface) {
  const evolution = npmAdaptationEvolution(input);
  return createNpmToolProductionPlan({ workspaceId: input.workspaceId, installation: input.installation, ...selected, checks: facts.contract.checks,
    learning: { ...input.admission, contractId: facts.contractId }, ...(evolution === undefined ? {} : { evolution }) });
}

async function publishConstruction(input: Input, facts: Facts, selected: NpmToolInterface, sourceChecked: boolean): Promise<Outcome> {
  if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);
  const plan = constructionPlan(input, facts, selected);
  if (plan === undefined) return pipelineFailure("invalid_npm_production_plan", "The restored interface no longer binds its reviewed installation or contract");
  const saved = await saveToolProductionPlan(input.boardRoot, plan, new Date(input.now()).toISOString(), input.admission);
  return saved.ok ? { ok: true, versionId: saved.versionId, sourceChecked } : saved;
}
