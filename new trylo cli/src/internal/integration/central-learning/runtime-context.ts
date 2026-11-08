import { createCentralRuntimeStore } from "./runtime-store.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralJudgmentControlRefs, isCentralJudgmentContextMaterial, readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { createCentralJudgmentProjection } from "./runtime-judgment.js";

/** Domain stages receive the selected purpose, knowledge and concrete operation.
 * Bookkeeping transitions (ready -> running) do not change this semantic frame. */
export function createCentralRuntimeContextReader(options: {
  readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean;
  readonly fallback?: CentralLearningContextReader;
}): CentralLearningContextReader {
  const store = createCentralRuntimeStore(options);
  return async issueId => {
    const snapshot = await store.read(options.scope);
    const board = await createBoardReader(options.boardRoot).load();
    if (!board.ok) throw new Error(board.reason);

    const native = board.state.learningIssues?.find(row => row.issueId === issueId && row.scope === options.scope);
    const intent = snapshot.state.intents.find(row => (row.subject.plane === "agent" && row.subject.issueId === issueId
      || row.subject.plane === "central" && native?.reports.some(report => report.evidenceRefs.includes(row.intentId)))
      && (row.continuation.kind === "ready" || snapshot.state.running.some(work => work.intentId === row.intentId)));
    if (intent === undefined) return options.fallback?.(issueId);

    const operation = intent.continuation.kind === "ready" ? intent.continuation.operation
      : snapshot.state.running.find(work => work.intentId === intent.intentId)?.operation;
    if (operation === undefined) return options.fallback?.(issueId);

    const { continuation: _continuation, revisionReason: _revisionReason, ...purpose } = intent;
    const relevant = new Set([...operation.sourceRefs, ...intent.sourceRefs, ...(intent.derivation?.parentRefs ?? []),
      ...intent.knowledge.flatMap(row => row.sourceRefs)]);
    const selected = new Map<string, CentralRuntimeMaterial>(), missing: string[] = [];

    for (const ref of relevant) {
      const current = snapshot.state.materials.find(row => row.ref === ref);
      if (current !== undefined) selected.set(ref, current);
      else missing.push(ref);
    }

    if (missing.length > 0) {
      const archived = await store.lookupMany(options.scope, missing.map(ref => ({ kind: "material", ref })));
      for (const result of archived) if (result.status === "found" && "kind" in result.value && "text" in result.value) selected.set(result.value.ref, result.value);
    }

    // Batch IO must preserve the original dependency order and context identity.
    const materials = [...relevant].flatMap(ref => {
      const material = selected.get(ref);
      return material === undefined ? [] : [material];
    });
    const projected = createCentralJudgmentProjection({ facts: board.state.rewardV2Facts ?? [], scope: options.scope,
      boardSequence: board.state.sequence }).materials(materials);
    const judgmentRefs = centralJudgmentControlRefs(projected);
    const judgments = projected.filter(material => readCentralJudgmentMaterial(material) !== undefined);
    const business = judgmentRefs.size === 0 ? materials
      : projected.filter(material => !isCentralJudgmentContextMaterial(material, judgmentRefs));
    const original = await options.fallback?.(issueId);
    const text = canonicalJson({ type: "central_runtime_learning_signal", schemaVersion: 1, intent: purpose,
      operation, materials: business, ...(judgments.length === 0 ? {} : { judgments }),
      original: original ?? null, interpretation: "public_learning_purpose_and_residual_not_permission_or_quality_verdict" });

    return { ref: `central-runtime-context:${contentHashOf(text)}`, text };
  };
}
