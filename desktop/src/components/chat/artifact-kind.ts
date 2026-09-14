// Trylo Desktop — artifact kind resolution (display decision only).
//
// 2026-09-10 (applyWorkItem deletion面): extracted from the deleted
// `work-item-mapper.ts`. This was the ONLY live export of that module —
// `Message.tsx` (artifact card) and the Dock resolve the card kind through
// this single helper. Everything else in the mapper (applyWorkItem /
// applyTaskItem / applyItem / upsertThinking) had zero production callers
// and was deleted with the WorkflowMessage chain.

import {
  detectArtifactKind,
  type ArtifactKind,
} from '@trylo/work';

const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'document', 'presentation', 'spreadsheet', 'web', 'file',
];

/** Resolve the card kind for an artifact: accept only known
 *  upstream hints, otherwise derive from the file extension;
 *  unknown extensions render as a generic `file` card (P2-1,
 *  spec §8.6) — never a pretend document. Display decision
 *  only — both the inline card and the Dock go through this
 *  single helper. */
export function resolveArtifactKind(
  hint: string | undefined,
  filePath: string,
): ArtifactKind {
  if (hint !== undefined && (ARTIFACT_KINDS as readonly string[]).includes(hint)) {
    return hint as ArtifactKind;
  }
  return detectArtifactKind(filePath);
}
