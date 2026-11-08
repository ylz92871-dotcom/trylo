import { isOutputArtifactPath } from './output-files/eligibility'
import type { StoredWorkResult } from './conversation-result-types'
import type { ArtifactRecord, ArtifactResult, ArtifactRunDelta } from './artifact-types'

function eligibleDeltaId(id: string): boolean {
  if (/^https?:\/\//i.test(id)) return true
  return isOutputArtifactPath(id.replace(/^file:/, ''))
}

/** Keep the visible records and their run attribution in the same order before
 * persistence applies its existing ID bound. Never infer an update from mtime. */
export function alignWorkRunDelta<T extends ArtifactRunDelta>(
  delta: T,
  artifacts: readonly ArtifactRecord[],
  limit?: number,
): T {
  const visible = new Set(artifacts.map((artifact) => artifact.id))
  const created = new Set(delta.createdIds.filter(eligibleDeltaId))
  const updated = new Set(delta.updatedIds.filter(eligibleDeltaId))
  const discovered = new Set(delta.discoveredIds.filter(eligibleDeltaId))

  const ordered = (ids: ReadonlySet<string>): readonly string[] => {
    const retained = artifacts
      .filter((artifact) => ids.has(artifact.id))
      .map((artifact) => artifact.id)
    return limit === undefined
      ? [...retained, ...[...ids].filter((id) => !visible.has(id))]
      : retained.slice(0, limit)
  }
  return {
    ...delta,
    createdIds: ordered(created),
    updatedIds: ordered(updated),
    discoveredIds: ordered(discovered),
  }
}

/** Read-time repair of derived result metadata, never deletion of user files. */
export function eligibleWorkResult(result: StoredWorkResult): StoredWorkResult
export function eligibleWorkResult(result: ArtifactResult): ArtifactResult
export function eligibleWorkResult(result: ArtifactResult): ArtifactResult {
  const artifacts = result.artifacts.filter(
    (artifact) =>
      artifact.target.kind === 'url' || isOutputArtifactPath(artifact.target.relativePath),
  )
  const removed = result.artifacts.length - artifacts.length
  const removedIds = new Set(
    result.artifacts
      .filter((artifact) => !artifacts.includes(artifact))
      .map((artifact) => artifact.id),
  )
  const latest = result.latestRun
  const recordedIds = new Set(
    latest ? [...latest.createdIds, ...latest.updatedIds, ...latest.discoveredIds] : [],
  )
  // The former persistence format independently kept its first 200 IDs.
  // A disjoint capped set proves lost attribution, not creation. Recover only
  // the recorded observation; ordinary empty deltas must stay empty.
  const clippedAttribution =
    latest &&
    [latest.createdIds, latest.updatedIds, latest.discoveredIds].some(
      (ids) => ids.length === 200,
    ) &&
    !artifacts.some((artifact) => recordedIds.has(artifact.id))
  const recoveredIds = clippedAttribution
    ? artifacts
        .filter((artifact) => artifact.lastRunId === latest.runId)
        .map((artifact) => artifact.id)
    : []
  const latestRun = latest
    ? alignWorkRunDelta(
        {
          ...latest,
          createdIds: latest.createdIds.filter((id) => !removedIds.has(id)),
          updatedIds: latest.updatedIds.filter((id) => !removedIds.has(id)),
          discoveredIds: [
            ...latest.discoveredIds.filter((id) => !removedIds.has(id)),
            ...recoveredIds,
          ],
        },
        artifacts,
      )
    : undefined
  const artifactCountTotal = Math.max(artifacts.length, result.artifactCountTotal - removed)
  return { ...result, artifacts, artifactCountTotal, ...(latestRun ? { latestRun } : {}) }
}
