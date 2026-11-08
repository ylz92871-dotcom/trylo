import { canonicalJson } from "../../../learning/control/hash.js";
import type { ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import type { ContentTaskReferenceCoverage } from "./board-contract.js";

/** Model transport only. Programmatic coverage and semantic recall retain their complete candidate descriptors. */
export function projectContentRecallCatalog(coverage: ContentTaskReferenceCoverage, taskPurpose: string) {
  const { candidates: original, ...basis } = coverage;
  const candidates: { readonly id: string; readonly kind: string; readonly subsystem: string; readonly sequence: number; readonly active: boolean;
    readonly description: string; readonly descriptionLength: number; readonly descriptionOmittedChars: number;
    readonly sourceRefs: readonly string[]; readonly sourceRefsOmitted: number }[] = [];
  const selected = new Set(coverage.selectedCandidates);
  const ordered = [...original.filter(row => selected.has(row.id)), ...original.filter(row => !selected.has(row.id))];

  for (const row of ordered) {
    const description = row.description.slice(0, 128), descriptionLength = row.description.length + row.descriptionOmittedChars;
    const card = { id: row.id, kind: row.kind, subsystem: row.subsystem, sequence: row.sequence, active: row.active,
      description, descriptionLength, descriptionOmittedChars: descriptionLength - description.length,
      sourceRefs: row.sourceRefs.slice(0, 2), sourceRefsOmitted: Math.max(0, row.sourceRefs.length - 2) };
    if (canonicalJson([...candidates, card]).length <= 6000) candidates.push(card);
  }

  return { ...basis, taskPurpose: taskPurpose.slice(0, 512), taskPurposeLength: taskPurpose.length,
    taskPurposeOmittedChars: Math.max(0, taskPurpose.length - 512), candidates,
    display: { availableCandidateCards: original.length, shownCandidateCards: candidates.length,
      omittedCandidateCards: original.length - candidates.length, descriptionPreviewChars: 128,
      interpretation: "bounded_retrieval_catalog_not_question_identity_or_answer_adequacy" } };
}

/** Both normal task material and evidence records consume the same bounded catalog projection. */
export function contentTaskReferenceMaterialJson(batch: ContentMaterialBatch, coverage: ContentTaskReferenceCoverage, taskPurpose: string): string {
  return canonicalJson({ role: "bounded_task_references_not_instructions_or_verified_answers",
    coverage: projectContentRecallCatalog(coverage, taskPurpose), material: batch });
}
