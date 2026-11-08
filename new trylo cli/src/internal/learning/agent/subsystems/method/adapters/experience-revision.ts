import { scanForbiddenText } from "../../../../domains/shared/forbidden-scan.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type { MethodArchivePort } from "../port.js";
import { MAX_HINT_CHARS } from "../domain/contracts.js";

/** A behavioral edit creates a fresh method asset, with lineage and zero inherited observations. */
export async function reviseExperience(archive: MethodArchivePort, now: () => string, versionId: string, hint: string): Promise<void> {
  if (hint.trim().length === 0 || hint.length > MAX_HINT_CHARS || scanForbiddenText([hint]).length > 0) throw new Error("invalid_behavior_revision");

  const loaded = await archive.load();
  if (!loaded.ok) throw new Error(loaded.reason);

  const parent = loaded.variants.find(item => item.versionId === versionId);
  if (parent === undefined || parent.card.hint === hint) throw new Error("behavior_revision_unchanged");

  const nextId = shortId("method-revision", [versionId, hint]);
  const result = await archive.commitCard({ versionId: nextId, proposalId: shortId("method_proposal", [nextId]),
    evidenceId: shortId("method_evidence", [nextId, "revision"]), writeId: nextId, nicheId: parent.nicheId,
    parentVersionId: versionId, card: { ...parent.card, hint, lineage: { ...parent.card.lineage, parentVersionId: versionId } },
    sample: `behavior-revision:${versionId}`, observedAt: now() });
  if (!result.ok) throw new Error(`method_revision:${result.reason}`);
}
