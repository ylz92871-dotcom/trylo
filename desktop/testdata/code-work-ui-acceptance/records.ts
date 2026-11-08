import type { ChatMessage } from '../../src/components/chat/types'
import type {
  StoredCodeRunResult,
  StoredWorkArtifact,
  StoredWorkResult,
} from '../../src/results/conversation-result-types'

export const markdownRelative = '.trylo/out/review.md'
export const historicalPdfRelative = '.trylo/out/archive.pdf'

export function longPath(index: number): string {
  return `.trylo/out/项目交付资料/用于检查侧栏宽度与滚动的完整目录/持续构建与预览/章节-${String(index + 1).padStart(2, '0')}-项目说明和验收记录.md`
}

const longPaths = Array.from({ length: 36 }, (_, index) => longPath(index))
const filePaths = [markdownRelative, ...longPaths]
const startedAt = 1_794_153_600_000
const finishedAt = startedAt + 12_400

export function makeCodeResult(sessionId: string, empty = false): StoredCodeRunResult {
  const paths = empty ? [] : filePaths
  const outputPaths = empty ? [] : [...filePaths, historicalPdfRelative]
  return {
    meta: {
      runId: `run-${sessionId}`,
      turnId: `turn-${sessionId}`,
      startedAt,
      finishedAt,
      status: 'completed',
    },
    attribution: 'run_delta',
    changes: paths.map((path, index) => ({
      path,
      ...(index === 0 ? { oldPath: '.trylo/out/previous.md' } : {}),
      kind: index === 0 ? 'renamed' : 'modified',
      staged: false,
      unstaged: true,
      untracked: false,
      additions: 2,
      deletions: 1,
    })),
    checks: empty
      ? []
      : [
          {
            id: `run-${sessionId}:typecheck`,
            label: '说明文档检查',
            kind: 'typecheck',
            status: 'passed',
            durationMs: 125,
          },
        ],
    outputs: outputPaths.map((path) => ({
      path,
      change: 'updated',
      signature: { size: 128, modifiedMs: finishedAt },
    })),
    outputCountTotal: outputPaths.length,
    changeCountTotal: paths.length,
    checkCountTotal: empty ? 0 : 1,
    truncated: false,
    additionsTotal: paths.length * 2,
    deletionsTotal: paths.length,
    statsComplete: true,
  }
}

export function makeWorkResult(sessionId: string, empty = false): StoredWorkResult {
  const runId = `run-${sessionId}`
  const turnId = empty ? 'old-turn' : `turn-${sessionId}`
  const metadata = {
    version: 1,
    firstSeenAt: startedAt,
    updatedAt: finishedAt,
    firstRunId: runId,
    lastRunId: runId,
    lastTurnId: turnId,
    lastChange: 'created' as const,
    sources: ['event'] as const,
  }
  const artifacts: StoredWorkArtifact[] = filePaths.map((path) => ({
    ...metadata,
    id: `file:${path}`,
    target: { kind: 'file', relativePath: path },
    displayName: path.split('/').at(-1) ?? path,
    artifactKind: 'document',
    signature: { size: 128, modifiedMs: finishedAt },
  }))
  artifacts.push({
    ...metadata,
    id: 'url:https://example.test/result.html',
    target: { kind: 'url', url: 'https://example.test/result.html' },
    displayName: 'result.html',
    artifactKind: 'web',
  })
  const createdIds = artifacts.map((artifact) => artifact.id)
  artifacts.push({
    ...metadata,
    id: `file:${historicalPdfRelative}`,
    target: { kind: 'file', relativePath: historicalPdfRelative },
    displayName: 'archive.pdf',
    artifactKind: 'file',
    firstRunId: 'history-run',
    lastRunId: 'history-run',
    lastTurnId: 'history-turn',
    lastChange: 'unchanged',
  })

  return {
    latestRun: {
      runId,
      turnId,
      startedAt,
      finishedAt,
      status: 'completed',
      createdIds,
      updatedIds: [],
      discoveredIds: [],
    },
    artifacts,
    artifactCountTotal: artifacts.length,
    truncated: false,
  }
}

export function makeMessages(sessionId: string, empty = false): ChatMessage[] {
  const turnId = `turn-${sessionId}`
  return [
    {
      id: turnId,
      kind: 'text',
      role: 'user',
      createdAt: startedAt,
      turnId,
      turnStartedAt: startedAt,
      turnTiming: { elapsedMs: finishedAt - startedAt, outcome: 'completed' },
      text: empty ? '继续讨论下一步。' : '请整理项目说明',
    },
    {
      id: `assistant-${sessionId}`,
      kind: 'text',
      role: 'assistant',
      createdAt: finishedAt,
      turnId,
      text: empty ? '可以，我们继续讨论。' : '已完成说明文档和检查。',
    },
  ]
}
