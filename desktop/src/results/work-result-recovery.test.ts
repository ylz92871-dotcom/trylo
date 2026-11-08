import { describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifact-store'
import { normalizeStoredWorkResult } from './conversation-result-normalizer'
import type { ArtifactRunScope, ScannedArtifact } from './artifact-types'
import type { StoredWorkArtifact, StoredWorkResult } from './conversation-result-types'

const run: ArtifactRunScope = {
  projectKey: 'project',
  projectRoot: 'D:/project',
  conversationId: 'conversation',
  runId: 'run',
  turnId: 'turn',
  startedAt: 100,
}
const file = (path: string): ScannedArtifact => ({
  id: path,
  target: { kind: 'file', relativePath: path },
  displayName: path.split('/').at(-1)!,
  artifactKind: 'file',
  absolutePath: `D:/project/${path}`,
  signature: { size: 1, modifiedMs: 200 },
})
const stored = (path: string): StoredWorkArtifact => ({
  ...file(path),
  version: 1,
  firstSeenAt: 100,
  updatedAt: 200,
  firstRunId: 'run',
  lastRunId: 'run',
  lastTurnId: 'turn',
  lastChange: 'created',
  sources: ['scan'],
})
function result(
  artifacts: readonly StoredWorkArtifact[],
  createdIds = artifacts.map((a) => a.id),
): StoredWorkResult {
  return {
    artifacts,
    artifactCountTotal: artifacts.length,
    truncated: false,
    latestRun: {
      runId: 'run',
      turnId: 'turn',
      startedAt: 100,
      finishedAt: 200,
      status: 'completed',
      createdIds,
      updatedIds: [],
      discoveredIds: [],
    },
  }
}

describe('deliverable metadata recovery', () => {
  it('keeps visible files attributed to this run after a 500-file scan and persistence', () => {
    const store = new ArtifactStore()
    store.beginRun(run, [])
    const snapshot = store.finishRun(run, {
      artifacts: Array.from({ length: 500 }, (_, i) => file(`out/report-${i}.pdf`)),
      truncated: false,
    })
    const persisted = normalizeStoredWorkResult(snapshot)
    expect(persisted.artifacts).toHaveLength(200)
    expect(persisted.artifactCountTotal).toBe(500)
    const latest = new Set(persisted.latestRun?.createdIds)
    expect(persisted.artifacts.every((artifact) => latest.has(artifact.id))).toBe(true)
  })

  it('recovers observation for old disjoint capped IDs without inventing creation', () => {
    const artifacts = Array.from({ length: 200 }, (_, i) => stored(`out/report-${i + 300}.pdf`))
    const oldIds = Array.from({ length: 200 }, (_, i) => `out/report-${i}.pdf`)
    const repaired = normalizeStoredWorkResult(result(artifacts, oldIds))
    expect(repaired.latestRun?.createdIds).toEqual([])
    expect(new Set(repaired.latestRun?.discoveredIds)).toEqual(new Set(artifacts.map((a) => a.id)))
    expect(normalizeStoredWorkResult(repaired)).toEqual(repaired)
  })

  it('does not infer a new creation or update from an unchanged historical file', () => {
    const artifact = {
      ...stored('out/old.pdf'),
      firstRunId: 'older-run',
      lastChange: 'updated' as const,
    }
    const repaired = normalizeStoredWorkResult(result([artifact], []))
    expect(repaired.latestRun?.createdIds).toEqual([])
    expect(repaired.latestRun?.updatedIds).toEqual([])
    expect(repaired.latestRun?.discoveredIds).toEqual([])
  })

  it('removes stored runtime metadata and stale runtime IDs while keeping a real output', () => {
    const cache = stored(
      'viewport-profile-123-456/Default/declarative_performance_observer.db-journal',
    )
    const report = stored('.trylo/out/report.pdf')
    const polluted = result(
      [cache, report],
      [cache.id, 'viewport-profile-123-456/Default/LOCK', report.id],
    )
    const repaired = normalizeStoredWorkResult(polluted)
    expect(repaired.artifacts.map((a) => a.id)).toEqual([report.id])
    expect(repaired.latestRun?.createdIds).toEqual([report.id])
    expect(repaired.artifactCountTotal).toBe(1)
  })

  it('repairs direct store hydration and keeps URL and ordinary extensionless artifacts', () => {
    const cache = stored('demo.exe.WebView2/EBWebView/Default/LOG')
    const report = stored('out/LOCK')
    const url = {
      ...stored('link'),
      id: 'https://example.com/result',
      target: { kind: 'url' as const, url: 'https://example.com/result' },
    }
    const store = new ArtifactStore()
    store.hydrate('project::conversation', result([cache, report, url]))
    const repaired = store.snapshot('project', 'conversation')
    expect(repaired.artifacts.map((a) => a.id)).toEqual([report.id, url.id])
    expect(new Set(repaired.latestRun?.createdIds)).toEqual(new Set([report.id, url.id]))
    expect(repaired.artifactCountTotal).toBe(2)
  })
})
