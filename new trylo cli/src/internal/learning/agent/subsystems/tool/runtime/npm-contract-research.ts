import type { ToolLearningAllowance } from "../domain/evolution/learning-plan.js";
import { decodeNpmSourceRead, type NpmSourceRead, type NpmContractResearchBoundary } from "../domain/evolution/npm-learning.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";
import { recordOf } from "../domain/evolution/parse.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { readNpmLearningSourceReads, saveNpmLearningSourceRead } from "./npm-learning-progress.js";
import { readNpmLearningArtifact, saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";

export type NpmContractSourceView<Source = unknown> = { readonly source: Source; readonly sourceFingerprint: string };

export type { NpmContractResearchBoundary } from "../domain/evolution/npm-learning.js";

export type NpmContractResearchOptions<Source = unknown> = {
  readonly contractId: string; readonly initialSource: Source;
  readonly initialSourceFingerprint?: string;
  readonly prompt: (source: Source, allowance: ToolLearningAllowance, boundary: NpmContractResearchBoundary) => string | undefined;
  readonly readSource: (request: NpmSourceRead) => NpmContractSourceView<Source> | Promise<NpmContractSourceView<Source>>;
  readonly mergeSource?: (previous: Source, next: Source) => Source;
  /** Clean upstream or exact approved oracle corrections may reuse an existing implementation. */
  readonly reserveGenerationCall?: boolean;
};

type Outcome<Source> = PipelineFailure | { readonly ok: true; readonly response: unknown; readonly source: Source };

/** Contract design investigates the real API before freezing expectations, using the same lifetime grant. */
export async function researchNpmContract<Source>(input: NpmAdaptationInput, options: NpmContractResearchOptions<Source>): Promise<Outcome<Source>> {
  const progress = await readNpmLearningSourceReads(input, options.contractId);
  if (!progress.ok) return progress;

  const closedId = `npm-contract-research-closed_v1_${contentHashOf({ subjectId: input.admission.jobId, contractId: options.contractId })}`;
  const closedRecord = { type: "tool_npm_contract_research_closed", schemaVersion: 1, subjectId: input.admission.jobId,
    contractId: options.contractId, reason: "no_new_source" };
  const closed = await readNpmLearningArtifact(input.boardRoot, closedId, input.plan.scope);
  if (!closed.ok) return closed;

  if (closed.content !== undefined && contentHashOf(closed.content) !== contentHashOf(closedRecord)) return pipelineFailure("invalid_npm_contract_research_boundary", "The committed research boundary is not this exact task's closure");

  let boundary: NpmContractResearchBoundary = closed.content === undefined ? { kind: "open" } : { kind: "contract_only", reason: "no_new_source" };
  let source = options.initialSource;
  const seen = new Set<string>();

  if (options.initialSourceFingerprint !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(options.initialSourceFingerprint)) return pipelineFailure("invalid_npm_source_fingerprint", "The initial source must have a host fingerprint");
    seen.add(options.initialSourceFingerprint);
  }

  const inspect = async (request: NpmSourceRead, expectedFingerprint?: string): Promise<PipelineFailure | { readonly ok: true; readonly progress: "new" | "same" }> => {
    if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

    let view: NpmContractSourceView<Source>;

    try { view = await options.readSource(request); }
    catch { return pipelineFailure("npm_contract_source_unavailable", "The exact reviewed source coordinates could not be read"); }

    if (!recordOf(view) || typeof view.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(view.sourceFingerprint)) return pipelineFailure("invalid_npm_source_fingerprint", "Source research requires a bounded content hash");

    if (expectedFingerprint !== undefined && expectedFingerprint !== view.sourceFingerprint) return pipelineFailure("npm_contract_source_changed", "Restored source coordinates no longer identify the originally inspected bytes");

    if (expectedFingerprint === undefined && seen.has(view.sourceFingerprint)) return { ok: true, progress: "same" };

    seen.add(view.sourceFingerprint);
    source = options.mergeSource === undefined ? view.source : options.mergeSource(source, view.source);

    if (expectedFingerprint !== undefined) return { ok: true, progress: "new" };

    const saved = await saveNpmLearningSourceRead(input, { contractId: options.contractId, request, sourceFingerprint: view.sourceFingerprint });

    return saved.ok ? { ok: true, progress: "new" } : saved;
  };

  // No provider call or archive fetch is needed: these coordinates address already-reviewed bytes.
  for (const read of progress.reads) {
    const restored = await inspect(read.request, read.sourceFingerprint);
    if (!restored.ok) return restored;
  }

  for (let step = 0; step < 8; step++) {
    if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

    const allowance = await input.services.allowance();
    const reserve = options.reserveGenerationCall === false ? 0 : 1;
    if (allowance === undefined || allowance.callsRemaining < 1 + reserve || allowance.tokensRemaining < 128) {
      return pipelineFailure("npm_contract_research_budget_exhausted", "The original central allowance must retain a contract decision and its reserved source-generation call");
    }

    if (boundary.kind === "open" && allowance.callsRemaining <= 1 + reserve) boundary = { kind: "contract_only", reason: "reserved_calls" };

    if (boundary.kind === "open" && step === 7) boundary = { kind: "contract_only", reason: "research_limit" };

    const prompt = options.prompt(source, allowance, boundary);
    if (prompt === undefined || prompt.length > allowance.maxPromptChars) {
      return pipelineFailure("npm_contract_context_exceeds_allowance", "The frozen requirements and bounded API evidence do not fit this task's central prompt allowance");
    }

    let raw: unknown;

    try { raw = await input.services.complete(prompt, input.signal, "contract"); }
    catch (error) {
      return pipelineFailure(input.signal.aborted ? "cancelled" : error instanceof ToolLearningServiceError ? error.code : "npm_contract_research_service_failed",
        "The centrally funded contract decision did not complete");
    }

    if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

    const read = decodeNpmSourceRead(raw);
    if (read === undefined) return { ok: true, response: raw, source };

    if (boundary.kind === "contract_only") return pipelineFailure("npm_contract_research_closed", "Research is closed: a final frozen contract or explicit deferral was required; the implementation reserve was not spent");

    const inspected = await inspect(read);
    if (!inspected.ok) return inspected;

    if (inspected.progress === "same") {
      boundary = { kind: "contract_only", reason: "no_new_source" };
      const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId: closedId, content: closedRecord, issuedAt: new Date(input.now()).toISOString() });
      if (!saved.ok) return saved;
    }
  }

  return pipelineFailure("npm_contract_research_step_limit", "No frozen contract after eight bounded API-research decisions");
}
