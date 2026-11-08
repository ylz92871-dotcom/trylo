import type { WorkflowCorrection, WorkflowTask } from "../domain/trace-contracts.js";
import { workflowMatches } from "../domain/family.js";
import { selectWorkflowPath } from "../domain/trace-select.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowVersion } from "./archive.js";
import type { WorkflowAssetVisibility } from "./asset-visibility.js";

type CorrectionOrigin = { readonly version: WorkflowVersion; readonly correction: WorkflowCorrection };

export type ExplicitWorkflowCorrection = {
  readonly sourceVersionId: string; readonly task: WorkflowTask; readonly correction: WorkflowCorrection;
  readonly visibility?: WorkflowAssetVisibility;
};

export type WorkflowRecommendation = {
  readonly nomination?: WorkflowVersion;
  readonly learningParent?: WorkflowVersion;
  readonly correctionVersionId?: string;
};

/** Immutable Board order is the existing arrival order, not a score or an active
 * pointer. Explicit history remains runnable outside this automatic-only view. */
export function recommendAutomaticWorkflow(versions: readonly WorkflowVersion[], task: WorkflowTask): WorkflowRecommendation {
  const byId = new Map(versions.map(version => [version.versionId, version]));
  const origins = correctionOrigins(versions, byId);
  const matching = versions.filter(version => workflowMatches(version.artifact, task));
  const constraints = new Map<string, CorrectionOrigin>();
  let floor: WorkflowVersion | undefined;

  for (const version of matching) {
    const origin = origins.get(version.versionId);
    if (origin === undefined || origin.version.versionId !== version.versionId) continue;
    const correction = origin.correction;
    if (!originApplies(origin, task)) continue;
    constraints.set(correction.nodeId, { version, correction });
    floor = version;
  }

  const eligible = floor === undefined ? matching : matching.filter(version => descendsFrom(version, floor!.versionId, byId));
  const nomination = [...eligible].reverse().find(version => satisfiesCorrections(version, task, [...constraints.values()], origins.get(version.versionId)));
  // Learning needs a parent even when the latest graph cannot yet satisfy every
  // correction. New facts stay in the corrected lineage without executing it.
  const learningParent = eligible.at(-1);

  return { ...(nomination === undefined ? {} : { nomination }), ...(learningParent === undefined ? {} : { learningParent }),
    ...(floor === undefined ? {} : { correctionVersionId: floor.versionId }) };
}

/** Materialize only the existing optional when field, without rewriting history. */
export function inheritedWorkflowCorrection(versions: readonly WorkflowVersion[], parentVersionId: string): WorkflowCorrection | undefined {
  const byId = new Map(versions.map(version => [version.versionId, version]));
  return correctionOrigins(versions, byId).get(parentVersionId)?.correction;
}

/** A host projects explicit intent independently from any historical path recommendation. */
export function explicitWorkflowCorrections(versions: readonly WorkflowVersion[], scope: string): readonly ExplicitWorkflowCorrection[] {
  const origins = correctionOrigins(versions, new Map(versions.map(version => [version.versionId, version])));
  const latest = new Map<string, ExplicitWorkflowCorrection>();

  for (const version of versions) {
    const origin = origins.get(version.versionId);
    if (version.source !== "user_explicit" || version.artifact.scope !== scope || origin?.version.versionId !== version.versionId) continue;

    const correction = origin.correction;
    // Arrival selects the latest real intent before eligibility. A withdrawn
    // latest origin shadows its older equivalent instead of resurrecting it.
    const key = contentHashOf({ scope, taskFamily: version.artifact.taskFamily, nodeId: correction.nodeId, when: correction.when ?? {} });

    latest.set(key, { sourceVersionId: version.versionId, task: { scope: version.artifact.scope, taskFamily: version.artifact.taskFamily,
      ...(version.artifact.conditions === undefined ? {} : { conditions: version.artifact.conditions }) }, correction,
      ...(version.visibility === undefined ? {} : { visibility: version.visibility }) });
  }

  return [...latest.values()];
}

function correctionOrigins(versions: readonly WorkflowVersion[], byId: ReadonlyMap<string, WorkflowVersion>): ReadonlyMap<string, CorrectionOrigin> {
  const origins = new Map<string, CorrectionOrigin>(), visited = new Set<string>();

  function resolve(version: WorkflowVersion): CorrectionOrigin | undefined {
    const cached = origins.get(version.versionId);
    if (cached !== undefined) return cached;

    if (visited.has(version.versionId) || version.artifact.correction === undefined) return undefined;

    visited.add(version.versionId);
    const correction = version.artifact.correction, parent = byId.get(version.artifact.parentVersionId ?? "");
    const parentOrigin = parent === undefined ? undefined : resolve(parent);
    // Legacy inferred differences express intent, except raw or scope-materialized
    // inheritance. New explicit same-value reaffirmations always remain intents.
    const inherited = version.source !== "user_explicit" && parentOrigin !== undefined && parent?.artifact.correction !== undefined
      && (contentHashOf(correction) === contentHashOf(parent.artifact.correction)
        || contentHashOf(correction) === contentHashOf({ ...parent.artifact.correction, when: parentOrigin.correction.when }));
    const origin = inherited ? parentOrigin : { version, correction: { ...correction, when: correction.when ?? version.artifact.conditions ?? {} } };

    origins.set(version.versionId, origin);
    return origin;
  }

  for (const version of versions) resolve(version);

  return origins;
}

function descendsFrom(version: WorkflowVersion, floor: string, byId: ReadonlyMap<string, WorkflowVersion>): boolean {
  const visited = new Set<string>();
  let current: WorkflowVersion | undefined = version;

  while (current !== undefined && !visited.has(current.versionId)) {
    if (current.versionId === floor) return true;
    visited.add(current.versionId);
    current = byId.get(current.artifact.parentVersionId ?? "");
  }

  return false;
}

function originApplies(origin: CorrectionOrigin, task: WorkflowTask): boolean {
  return Object.entries(origin.correction.when ?? {}).every(([key, value]) => task.conditions?.[key] === value);
}

function satisfiesCorrections(version: WorkflowVersion, task: WorkflowTask, origins: readonly CorrectionOrigin[], ownOrigin: CorrectionOrigin | undefined): boolean {
  const selected = selectWorkflowPath(version.artifact, task);
  if (!selected.ok) return false;

  if (ownOrigin !== undefined && !originApplies(ownOrigin, task)) {
    const correction = ownOrigin.correction, branch = version.artifact.branches?.find(item => item.id === selected.value.adoptedBranchId);
    // Historical omitted-when children could reapply a scoped correction to a
    // different branch. Preserve their bytes, but do not automatically execute
    // the out-of-scope overlay identified by its existing provenance.
    const changedNode = selected.value.artifact.nodes.some(node => node.id === correction.nodeId && node.check === correction.check);
    const claimed = branch?.checkProvenance?.some(item => item.nodeId === correction.nodeId && item.check === correction.check)
      || selected.value.artifact.recovery.some(lesson => lesson.afterNode === correction.nodeId && lesson.evidenceRefs.includes(`correction:${version.artifact.requestId}`));
    if (changedNode && claimed) return false;
  }

  return origins.every(({ correction }) => selected.value.artifact.nodes.some(node => node.id === correction.nodeId && node.check === correction.check)
    && selected.value.artifact.recovery.find(lesson => lesson.afterNode === correction.nodeId)?.goto === correction.recoveryTo);
}
