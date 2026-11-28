import { expect, it, vi } from 'vitest'
import type { ProcessService } from '../host-adapter/process-service'
import type { FilePath } from '../host-adapter/types'
import { acquisitionTestOwner, failedAcquisitionFixture } from './acquisition-test-support'
import { acquisitionInquiryFixture, committedAcquisitionInquiryFixture, strategyAcquisitionInquiryFixture } from './acquisition-inquiry-test-support'
import { parseToolAcquisitionInquiryReview } from './acquisition-inquiry-contract'
import { confirmToolAcquisitionInquiry, loadToolAcquisitionInquiry } from './cli-acquisition-inquiry'

const paths = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath }
it('binds inquiry to the exact failure and copies only its safe snapshot projection', () => {
  const original = failedAcquisitionFixture(), ready = acquisitionInquiryFixture(original)
  const parse = (raw: unknown) => parseToolAcquisitionInquiryReview(JSON.stringify(raw), original)
  expect(parse({ ok: true, ...ready, snapshot: { secret: 'TEST_ONLY_private' }, providerDiagnostics: 'TEST_ONLY_private' })).toEqual({ ok: true, value: ready })
  const committed = committedAcquisitionInquiryFixture(original)
  expect(parse({ ok: true, ...committed })).toEqual({ ok: true, value: committed })
  expect(parse({ ok: true, ...committed, outcome: { ...committed.outcome, proposal: { ...committed.outcome!.proposal, request: { source: 'TEST_ONLY_private' } } } })).toEqual({ ok: true, value: committed })
  expect(parse({ ok: true, ...committed, outcome: { ...committed.outcome, proposal: { ...committed.outcome!.proposal, rationale: 'x'.repeat(2049) } } }).ok).toBe(false)
  for (const change of [{ jobId: `tool-learning_v1_${'9'.repeat(64)}` }, { approvalId: 'latest' }, { workspaceId: 'workspace:foreign' },
    { failureRef: `tool-acquisition-failure_v1_${'9'.repeat(64)}` }, { ready: false }, { reviewId: 'latest' },
    { budget: { ...ready.budget, remaining: { calls: 0, tokens: 12000 } } }, { attempt: 4 },
    { recovery: { recoverable: true, attempt: 0, reviewId: ready.reviewId } }]) expect(parse({ ok: true, ...ready, ...change }).ok).toBe(false)
  expect(parse({ ok: true, ...committed, reviewId: undefined }).ok).toBe(false)
  const strategy = strategyAcquisitionInquiryFixture(original)
  expect(parse({ ok: true, ...strategy })).toEqual({ ok: true, value: strategy })
  expect(parse({ ok: true, ...committed, outcome: { status: 'proposed', code: 'inquiry_proposal_pending_review', proposal: committed.outcome!.proposal } }).ok).toBe(false)
  expect(parse({ ok: true, ...strategy, outcome: { ...strategy.outcome, reviewJobId: committed.outcome!.reviewJobId, approvalId: committed.outcome!.approvalId } }).ok).toBe(false)
})
it('starts only after explicit exact confirmation and never adds execution or acquisition authorization', async () => {
  const original = failedAcquisitionFixture(), review = acquisitionInquiryFixture(original), calls: string[][] = []
  const runtime = { ...paths, ...acquisitionTestOwner(), process: { async spawn(options: Parameters<ProcessService['spawn']>[0]) {
    calls.push([...options.args]); options.onOutput(JSON.stringify(options.args.includes('--approve') ? { ok: true } : { ok: true, ...review }))
    options.onExit?.({ id: 'TEST_ONLY_inquiry', pid: 1, code: 0, signal: null })
    return { id: 'TEST_ONLY_inquiry', pid: 1, label: options.label, command: options.command }
  }, stop: async () => {} } }, signal = new AbortController().signal
  expect(await loadToolAcquisitionInquiry(runtime, original, signal)).toEqual({ ok: true, value: review })
  expect(calls).toHaveLength(1); expect(calls[0]).not.toContain('--approve')
  expect(await confirmToolAcquisitionInquiry(runtime, original, review, signal)).toEqual({ ok: true, value: { requestFinished: true } })
  expect(calls[1]?.slice(-10)).toEqual(['tools', 'acquire-learning', original.jobId, '--reinvestigate-failure', original.failure!.ref,
    '--json', '--approve', original.approvalId, '--confirm-inquiry', review.reviewId])
  expect(calls.flat().some(arg => ['run_shell', '--allow-tools', '--resume-child', 'production-activate'].includes(arg))).toBe(false)
  expect((await confirmToolAcquisitionInquiry(runtime, original, committedAcquisitionInquiryFixture(original), signal)).ok).toBe(true)
  expect(calls).toHaveLength(3)
})
it('uses an independent recovery fence and refuses a pending native owner without another spawn', async () => {
  const original = failedAcquisitionFixture(), owner = acquisitionTestOwner(), spawn = vi.fn(), signal = new AbortController().signal
  const { reviewId: _startReview, ...base } = acquisitionInquiryFixture(original)
  void _startReview; // This fixture intentionally has no review starter.
  const review = { ...base, state: 'running' as const, attempt: 1, ready: false, next: 'inspect_or_wait' as const,
    code: 'inquiry_running_requires_inspection', recovery: { recoverable: true, attempt: 1, expiresAt: '2026-11-04T00:00:00.000Z', reviewId: `acquisition-inquiry-review_v1_${'8'.repeat(64)}` } }
  const runtime = { ...paths, ...owner, process: { spawn, stop: async () => {} } }
  expect(await confirmToolAcquisitionInquiry(runtime, original, review, signal)).toEqual({ ok: false, reason: 'acquisition_inquiry_not_ready' })
  const token = owner.lifecycle.starting?.(async () => {})
  expect(await confirmToolAcquisitionInquiry(runtime, original, review, signal, 'recover')).toEqual({ ok: false, reason: 'stop_unconfirmed' })
  expect(spawn).not.toHaveBeenCalled()
  if (token !== undefined) owner.lifecycle.spawnRejected?.(token)
  spawn.mockImplementation(async (options: Parameters<ProcessService['spawn']>[0]) => {
    options.onOutput('{"ok":true}'); options.onExit?.({ id: 'TEST_ONLY_recover', pid: 1, code: 0, signal: null })
    return { id: 'TEST_ONLY_recover', pid: 1, label: options.label, command: options.command }
  })
  expect((await confirmToolAcquisitionInquiry(runtime, original, review, signal, 'recover')).ok).toBe(true)
  expect(spawn.mock.calls[0]?.[0].args.slice(-2)).toEqual(['--confirm-inquiry-recovery', review.recovery.reviewId])
})
