import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ResultDock } from '../../src/components/chat/ResultDock'
import { ArtifactPreviewStrip } from '../../src/components/chat/ArtifactPreviewStrip'
import { WorkResultContent, latestRunArtifactCount } from '../../src/components/chat/WorkResultContent'
import { workPreviewFiles } from '../../src/components/chat/result-preview-files'
import { normalizeStoredWorkResult } from '../../src/results/conversation-result-normalizer'
import { ArtifactStore } from '../../src/results/artifact-store'
import { ConversationResultRepository } from '../../src/results/conversation-result-repository'
import type { StoredWorkArtifact, StoredWorkResult } from '../../src/results/conversation-result-types'
import { setAppearance } from '../../src/settings/appearance-store'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/components/disclosure.css'
import '../../src/styles/components/result-dock.css'
import '../../src/styles/components/artifact-card.css'
import './fixture.css'

const root = 'D:/Synthetic/TryloDeliverables'
const turnId = 'synthetic-delivery-turn'
const runId = 'synthetic-delivery-run'
const startedAt = 1794140000000
const selected = new URLSearchParams(location.search).get('case') ?? 'polluted'
setAppearance('light')

function artifact(relativePath: string, index: number): StoredWorkArtifact {
  return {
    id: relativePath,
    target: { kind: 'file', relativePath },
    displayName: relativePath.split('/').at(-1)!,
    artifactKind: 'file',
    version: 1,
    firstSeenAt: startedAt + index,
    updatedAt: startedAt + index,
    firstRunId: runId,
    lastRunId: runId,
    lastTurnId: turnId,
    lastChange: 'created',
    sources: ['scan'],
    signature: { size: 64 + index, modifiedMs: startedAt + index },
  }
}

const runtimeNames = [
  'Default/LOCK',
  'Default/LOG',
  'Default/DIPS',
  'Default/declarative_performance_observer.db-journal',
  'Default/Local Storage/leveldb/CURRENT',
  'Default/Local Storage/leveldb/MANIFEST-000001',
  'Default/Local Storage/leveldb/000003.log',
]
const polluted = Array.from({ length: 500 }, (_, index) => artifact(
  `viewport-profile-123-${456 + Math.floor(index / runtimeNames.length)}/${runtimeNames[index % runtimeNames.length]}`,
  index,
))
const report = artifact('.trylo/out/report.pdf', 501)
const raw: StoredWorkResult = {
  artifacts: [...polluted, report],
  artifactCountTotal: 501,
  truncated: false,
  latestRun: {
    runId, turnId, startedAt, status: 'completed',
    // Reproduce old persistence: the first 200 delta IDs omit the valid file.
    createdIds: polluted.slice(0, 200).map((item) => item.id),
    updatedIds: [], discoveredIds: [],
  },
}

function manyFiles(): StoredWorkResult {
  const scope = { projectKey: 'synthetic-project', projectRoot: root,
    conversationId: 'synthetic-conversation', runId, turnId, startedAt }
  const store = new ArtifactStore()
  store.beginRun(scope, [])
  const records = Array.from({ length: 500 }, (_, index) => artifact(
    `.trylo/out/deliverable-${String(index).padStart(4, '0')}.pdf`, index,
  ))
  const result = store.finishRun(scope, { truncated: false,
    artifacts: records.map((item) => ({ ...item,
      absolutePath: `${root}/${item.id}`, signature: item.signature!,
    })),
  })
  const repository = new ConversationResultRepository()
  repository.update(scope.projectKey, scope.conversationId, () => ({ schemaVersion: 1, work: result as StoredWorkResult }))
  const stored = repository.snapshot(scope.projectKey, scope.conversationId)?.work
  if (!stored) throw new Error('Synthetic store/repository did not retain its Work result')
  return stored
}

let result = selected === 'many' ? manyFiles() : normalizeStoredWorkResult(raw)
let expectedTurn = turnId
if (selected === 'empty') {
  result = normalizeStoredWorkResult({ ...result, latestRun: {
    runId: 'empty-run', turnId: 'empty-turn', startedAt: startedAt + 10000,
    status: 'completed', createdIds: [], updatedIds: [], discoveredIds: [],
  } })
  expectedTurn = 'empty-turn'
}
if (selected === 'new-turn') expectedTurn = 'new-turn-with-no-output'
const count = latestRunArtifactCount(result, { turnId: expectedTurn })
const previews = workPreviewFiles(result)
const latestIds = new Set([
  ...(result.latestRun?.createdIds ?? []),
  ...(result.latestRun?.updatedIds ?? []),
  ...(result.latestRun?.discoveredIds ?? []),
])
const summary = [
  result.latestRun?.createdIds.length ? `新建 ${result.latestRun.createdIds.length}` : '',
  result.latestRun?.updatedIds.length ? `更新 ${result.latestRun.updatedIds.length}` : '',
  result.latestRun?.discoveredIds.length ? `发现 ${result.latestRun.discoveredIds.length}` : '',
].filter(Boolean).join(' · ')
const proof = {
  selected,
  inputRuntimeCount: selected === 'many' ? 0 : polluted.length,
  artifactCount: result.artifacts.length,
  artifactCountTotal: result.artifactCountTotal,
  latestCount: count,
  truncated: result.truncated,
  latestVisibleCount: result.artifacts.filter((item) => latestIds.has(item.id)).length,
  createdCount: result.latestRun?.createdIds.length ?? 0,
  updatedCount: result.latestRun?.updatedIds.length ?? 0,
  discoveredCount: result.latestRun?.discoveredIds.length ?? 0,
  previewPaths: previews.map((item) => item.path),
  openPaths: [] as string[],
  hostCalls: [] as string[],
}
Object.assign(window, { deliverableProof: proof })
const preview = (value: string): void => { proof.openPaths.push(value) }
const host = {
  openFile: async (value: string) => { proof.hostCalls.push(`open:${value}`) },
  openFileWithApp: async (value: string) => { proof.hostCalls.push(`open-with:${value}`) },
  showInFolder: async (value: string) => { proof.hostCalls.push(`folder:${value}`) },
  copyToClipboard: async (value: string) => { proof.hostCalls.push(`copy:${value}`) },
}

function Fixture(): JSX.Element {
  const [open, setOpen] = useState(true)
  return <main className="deliverable-acceptance" data-case={selected}>
    {/* Same production turn/count guard as App; no private conversations. */}
    {result.latestRun && count > 0 ? <ResultDock
      id="synthetic-deliverables" mode="work" title="交付物" count={count}
      status="ready" summary={summary}
      truncated={result.truncated} open={open} onOpenChange={setOpen}
      onToggle={() => setOpen(false)}
      preview={<ArtifactPreviewStrip files={previews} onOpen={preview} />}
    >
      <WorkResultContent result={result} workspaceRoot={root} host={host}
        onPreviewArtifact={preview} onDiffArtifact={() => undefined} />
    </ResultDock> : null}
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
