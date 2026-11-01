import { STAGES, type ProductionDetail } from './production-contract'

/** TEST ONLY wire values; never a real production receipt or acceptance result. */
export function productionFixture(): ProductionDetail {
  return {
    formatVersion: 1,
    workspaceId: 'workspace:test',
    boardSequence: 9,
    versionId: `tool-production_v1_${'a'.repeat(64)}`,
    identity: 'test-formatter',
    description: 'TEST ONLY format supplied JSON',
    lifecycle: 'evaluating',
    profile: 'confined_npm_cli_v1',
    packageName: 'prettyjson',
    packageVersion: '1.2.5',
    license: 'MIT',
    dependencyCount: 0,
    checkState: 'succeeded',
    checkJobId: 'test-check-job',
    uses: { total: 0, returned: 0, quality: 'unverified' },
    capability: '整理传入的 JSON',
    mastery: {
      whenToUse: ['将小型 JSON 格式化为文本'],
      preconditions: ['通过 stdin 传入数据'],
      pitfalls: ['不会读取工作区文件'],
    },
    permissions: [],
    timeoutMs: 15000,
    source: [
      {
        origin: 'reviewed_npm_archive',
        name: 'prettyjson',
        version: '1.2.5',
        license: 'MIT',
        location: 'node_modules/prettyjson',
        upstreamUrl: 'https://github.com/rafeca/prettyjson',
        sourceRevision: 'b'.repeat(40),
        archiveSha256: 'c'.repeat(64),
        licenses: [{ path: 'LICENSE', sha256: 'd'.repeat(64) }],
      },
    ],
    review: {
      status: 'available',
      reviewId: `production-review_v1_${'e'.repeat(64)}`,
      receiptId: 'TEST-ONLY-receipt',
    },
    report: {
      jobId: 'test-check-job',
      verdict: 'pass',
      stages: STAGES.map((stage) => ({
        stage,
        passed: true,
        detail: 'TEST ONLY diagnostic stage',
      })),
    },
  }
}
export const productionListFixture = (detail = productionFixture()) => ({
  ok: true,
  formatVersion: 1,
  workspaceId: detail.workspaceId,
  boardSequence: detail.boardSequence,
  items: [detail],
  total: 1,
  truncated: false,
})
