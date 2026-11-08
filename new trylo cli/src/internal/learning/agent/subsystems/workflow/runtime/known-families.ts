import type { WorkflowLearningArtifact, WorkflowTask } from "../domain/trace-contracts.js";
import { workflowFamilyKey } from "../domain/family.js";
import { readLegacyWorkflowCatalog } from "./archive.js";
import { contentHashOf } from "../../../../control/hash.js";

/** One bounded, exact-scope family context shared by automatic and standalone learning. */
export function familiesFromVersions(versions: readonly { readonly artifact: WorkflowLearningArtifact }[], scope: string): readonly WorkflowTask[] {
  const known = new Map<string, WorkflowTask>();

  for (const { artifact } of versions) {
    if (artifact.scope !== scope) continue;

    const variants = artifact.branches?.map(branch => branch.when) ?? [artifact.conditions];

    for (const conditions of variants) {
      const task = { scope, taskFamily: artifact.taskFamily, ...(conditions === undefined ? {} : { conditions }) };
      const key = contentHashOf([workflowFamilyKey(artifact.taskFamily), conditions ?? {}]);
      known.delete(key);
      known.set(key, task);
    }
  }

  return [...known.values()].slice(-16);
}

export async function knownAutomaticWorkflowFamilies(boardRoot: string, scope: string) {
  const versions = await readLegacyWorkflowCatalog(boardRoot);
  return versions.ok ? { ok: true as const, value: familiesFromVersions(versions.value.providerVersions, scope) } : versions;
}
