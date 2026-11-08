import { afterEach, expect, it, vi } from 'vitest'
import type { ProcessService } from '../host-adapter/process-service'
import type { FilePath } from '../host-adapter/types'
import { approveToolAcquisition, loadToolAcquisitionReview, parseToolAcquisitionReview } from './cli-acquisition'
import { acquisitionCandidateVersion, acquisitionContinuationJob, acquisitionFixture, acquisitionInstallation, acquisitionTestOwner, preparedAcquisitionFixture, failedAcquisitionFixture } from './acquisition-test-support'

const paths = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath }
afterEach(() => { vi.useRealTimers() })
it('decodes the durable safe failure after remount and drops unprojected private diagnostics', () => {
  const fx = failedAcquisitionFixture(), parse = (raw: unknown) => parseToolAcquisitionReview(JSON.stringify(raw), fx.jobId, fx.workspaceId)
  const raw = { ok: true, ...fx, failure: { ...fx.failure, stderr: 'TEST ONLY private', retainedScratchDirectory: 'D:/TEST_ONLY_private',
    diagnostics: fx.failure!.diagnostics.map(row => ({ ...row, stderr: 'TEST ONLY private' })) } }
  const first = parse(raw), remounted = parse(raw)
  expect(first).toEqual(remounted); expect(first.ok).toBe(true)
  expect(JSON.stringify(first)).not.toContain('private'); expect(JSON.stringify(first)).not.toContain('stderr')
  for (const failure of [{ ...fx.failure, ref: 'latest' }, { ...fx.failure, phase: 'shell' }, { ...fx.failure, recovery: 'auto_retry' },
    { ...fx.failure, diagnostics: [{ packageName: 'D:/private', stage: 'metadata_fetch', code: 'timeout' }] }]) expect(parse({ ok: true, ...fx, failure }).ok).toBe(false)
})
it('does not launch another approval for a stored unsupported or unconfirmed-stop observation', async () => {
  const spawn = vi.fn(), runtime = { ...paths, ...acquisitionTestOwner(), process: { spawn, stop: async () => {} } }
  expect(await approveToolAcquisition(runtime, failedAcquisitionFixture(), new AbortController().signal)).toEqual({ ok: false, reason: 'acquisition_requires_investigation' })
  expect(await approveToolAcquisition(runtime, failedAcquisitionFixture('await_stop'), new AbortController().signal)).toEqual({ ok: false, reason: 'stop_unconfirmed' })
  expect(spawn).not.toHaveBeenCalled()
})
it('binds review and progress to this exact workspace and job, including a committed-candidate recovery', () => {
  const fx = acquisitionFixture(), parse = (raw: unknown) => parseToolAcquisitionReview(JSON.stringify(raw), fx.jobId, fx.workspaceId)
  expect(parse({ ok: true, ...fx }).ok).toBe(true)
  const prepared = preparedAcquisitionFixture()
  expect(parse({ ok: true, ...prepared, continuation: { ...prepared.continuation, state: 'running', recovery: 'committed_candidate' } }).ok).toBe(true)
  for (const change of [{ workspaceId: 'workspace:other' }, { jobId: `tool-learning_v1_${'f'.repeat(64)}` }, { formatVersion: 2 },
    { approvalId: 'latest' }, { candidate: { ...fx.candidate, version: '' } }, { installation: { ...acquisitionInstallation, packageCount: -1 } },
    { continuation: { jobId: acquisitionContinuationJob, state: 'active', attempt: 1 } },
    { installation: acquisitionInstallation, continuation: { jobId: acquisitionContinuationJob, state: 'running', attempt: 1, recovery: 'committed_candidate' } },
    { next: 'production_verify_then_explicit_activation' }]) expect(parse({ ok: true, ...fx, ...change }).ok).toBe(false)
})
it('reviews without mutation, then submits only the exact approval argv on an explicit call', async () => {
  const fx = acquisitionFixture(), calls: Parameters<ProcessService['spawn']>[0][] = []
  const process = { async spawn(options: Parameters<ProcessService['spawn']>[0]) {
    calls.push(options)
    options.onOutput(JSON.stringify(options.args.includes('--approve') ? { ok: true, versionId: acquisitionCandidateVersion } : { ok: true, ...fx }))
    options.onExit?.({ id: 'owned', pid: 1, code: 0, signal: null })
    return { id: 'owned', pid: 1, label: options.label, command: options.command }
  }, stop: async () => {} }, runtime = { ...paths, process, ...acquisitionTestOwner() }, signal = new AbortController().signal
  expect((await loadToolAcquisitionReview(runtime, fx.jobId, fx.workspaceId, signal)).ok).toBe(true)
  expect(calls[0]?.args.slice(-4)).toEqual(['tools', 'acquire-learning', fx.jobId, '--json'])
  expect((await approveToolAcquisition(runtime, { ...fx, approvalId: 'latest' }, signal)).ok).toBe(false)
  expect(calls).toHaveLength(1)
  expect(await approveToolAcquisition(runtime, fx, signal)).toEqual({ ok: true, value: { versionId: acquisitionCandidateVersion } })
  expect(calls[1]?.args.slice(-6)).toEqual(['tools', 'acquire-learning', fx.jobId, '--approve', fx.approvalId, '--json'])
  expect(calls[1]?.cwd).toBe(paths.cwd)
  expect(calls.flatMap(call => call.args).some(arg => ['run_shell', 'production-activate', '--allow-tools'].includes(arg))).toBe(false)
})
it('returns an approval refusal without retrying a mutation', async () => {
  let calls = 0
  const process = { async spawn(options: Parameters<ProcessService['spawn']>[0]) {
    calls++
    options.onOutput('{"ok":false,"code":"approval_plan_mismatch"}')
    options.onExit?.({ id: 'owned', pid: 1, code: 52, signal: null })
    return { id: 'owned', pid: 1, label: options.label, command: options.command }
  }, stop: async () => {} }
  expect(await approveToolAcquisition({ ...paths, process, ...acquisitionTestOwner() }, acquisitionFixture(), new AbortController().signal)).toEqual({ ok: false, reason: 'approval_plan_mismatch' })
  expect(calls).toBe(1)
})
it('uses the bounded long operation timeout and leaves a timed-out mutation unconfirmed', async () => {
  vi.useFakeTimers()
  const stop = vi.fn(async () => {}), spawn = vi.fn(async (options: Parameters<ProcessService['spawn']>[0]) => ({ id: 'owned', pid: 1, label: options.label, command: options.command }))
  const owner = acquisitionTestOwner(), runtime = { ...paths, process: { spawn, stop }, ...owner }
  const result = approveToolAcquisition(runtime, acquisitionFixture(), new AbortController().signal)
  await vi.advanceTimersByTimeAsync(299_999)
  expect(stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_001)
  expect(await result).toEqual({ ok: false, reason: 'stop_unconfirmed' })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledWith('owned')
  expect(owner.lifecycle.canStart?.()).toBe(false)
  expect((await approveToolAcquisition(runtime, acquisitionFixture(), new AbortController().signal))).toEqual({ ok: false, reason: 'stop_unconfirmed' })
  expect(spawn).toHaveBeenCalledTimes(1)
  spawn.mock.calls[0]?.[0].onExit?.({ id: 'owned', pid: 1, code: null, signal: null })
  expect(owner.lifecycle.canStart?.()).toBe(true)
  expect(spawn).toHaveBeenCalledTimes(1)
})
