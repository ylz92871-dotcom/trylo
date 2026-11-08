import type { ToolAcquisitionReview } from './acquisition-contract'
import type { CliCommandControlPort, CliCommandRecoveryPort } from '../host-adapter/cli-command'

/** TEST ONLY transport-owner fixture; production uses ConversationRunSupervisor. */
export function acquisitionTestOwner() {
  const entries = new Map<string, { state: 'running' | 'stopping' | 'stop_unconfirmed'; stop: () => Promise<void>; pending: boolean }>()
  const listeners = new Set<() => void>()
  let version = 0, launches = 0
  const changed = () => { version++; listeners.forEach(listener => listener()) }
  const lifecycle: CliCommandControlPort = {
    receive: () => {}, clearProcess: () => {},
    starting: stop => { const token = `TEST_ONLY_pending_${++launches}`; entries.set(token, { state: 'running', stop, pending: true }); changed(); return token },
    acquired: (handle, stop, token) => {
      const prior = token === undefined ? undefined : entries.get(token)
      if (token !== undefined) entries.delete(token)
      entries.set(handle.id, { state: prior?.state ?? 'running', stop, pending: false }); changed()
    },
    spawnRejected: token => { if (entries.delete(token)) changed() },
    stopping: id => { const entry = entries.get(id); if (entry) { entry.state = 'stopping'; changed() } },
    stopUnconfirmed: id => { const entry = entries.get(id); if (entry) { entry.state = 'stop_unconfirmed'; changed() } },
    exited: (id, token) => { const actual = entries.delete(id), pending = token === undefined ? false : entries.delete(token); if (actual || pending) changed() },
    canStart: () => ![...entries.values()].some(entry => entry.pending || entry.state !== 'running'),
  }
  const recovery: CliCommandRecoveryPort = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, getVersion: () => version,
    statuses: () => [...entries].flatMap(([processId, entry]) => entry.state === 'running' ? [] : [{ processId, workspaceRoot: 'D:/workspace', state: entry.state }]),
    retry: async id => { await entries.get(id)?.stop() },
  }
  return { lifecycle, recovery }
}

export function acquisitionFixture(overrides: Partial<ToolAcquisitionReview> = {}): ToolAcquisitionReview {
  return {
    formatVersion: 1, workspaceId: 'workspace:test', jobId: `tool-learning_v1_${'a'.repeat(64)}`,
    approvalId: `tool-decision_v1_${'b'.repeat(64)}`, capability: '为当前任务解析结构化文本',
    candidate: { platform: 'npm', id: '@trylo/example', version: '1.2.3', sourceUrl: 'https://registry.npmjs.org/@trylo/example', licenseSpdx: 'MIT' },
    rationale: '已有成熟解析接口，先复用其实现。', existingInsufficiency: '当前工具缺少该格式的解析能力。',
    expectedBenefit: '预计减少手写解析的错误，仍需后续任务反馈。', constructionCost: '需要隔离获取和一次有界适配。',
    alternatives: ['继续使用现有工具，保留当前格式限制。'], adaptation: '用只读 JSON 接口封装库入口。',
    action: 'resolve_download_install_and_prepare_immutable_adaptation', next: 'authorize_or_resume_acquisition', ...overrides,
  }
}
export const acquisitionInstallation = { installationId: `npm-install_v1_${'c'.repeat(64)}`, packageCount: 3, installed: true } as const
export const acquisitionCandidateVersion = `tool-production_v1_${'e'.repeat(64)}`
export const acquisitionContinuationJob = `tool-adaptation_v1_${'d'.repeat(64)}`

export function preparedAcquisitionFixture(): ToolAcquisitionReview {
  return acquisitionFixture({ installation: acquisitionInstallation, continuation: {
    jobId: acquisitionContinuationJob, state: 'waiting_approval', attempt: 1, versionId: acquisitionCandidateVersion,
  }, next: 'production_verify_then_explicit_activation' })
}
export function failedAcquisitionFixture(recovery: 'investigate' | 'retry_explicitly' | 'await_stop' = 'investigate'): ToolAcquisitionReview {
  return acquisitionFixture({ failure: { ref: `tool-acquisition-failure_v1_${'f'.repeat(64)}`, phase: 'resolve',
    code: recovery === 'investigate' ? 'npm_shrinkwrap_unsupported' : recovery === 'await_stop' ? 'npm_resolver_stop_unconfirmed' : 'npm_resolver_unavailable', recovery,
    diagnostics: recovery === 'investigate' ? [{ packageName: 'leaf', version: '1.1.0', stage: 'selected_archive_semantics', code: 'npm_shrinkwrap_unsupported' }] : [] } })
}
