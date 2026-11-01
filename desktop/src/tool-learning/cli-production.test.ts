import { expect, it } from 'vitest'
import type { ProcessService } from '../host-adapter/process-service'
import type { FilePath } from '../host-adapter/types'
import { runProductionAction, loadProductionList } from './cli-production'
import { parseProductionList, parseProductionDetail } from './production-contract'
import { productionFixture, productionListFixture } from './production-test-support'
const fx = productionFixture(),
  paths = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath }
it('accepts the versioned projection and rejects future, corrupt, foreign and partially validated views', () => {
  expect(parseProductionList(JSON.stringify(productionListFixture())).ok).toBe(true)
  expect(
    parseProductionDetail(
      JSON.stringify({ ok: true, desktopView: fx }),
      fx.versionId,
      fx.workspaceId,
    ).ok,
  ).toBe(true)
  for (const view of [
    { ...fx, formatVersion: 2 },
    { ...fx, workspaceId: 'other' },
    { ...fx, permissions: ['network'] },
    { ...fx, source: [] },
    { ...fx, review: { status: 'available', reviewId: 'latest', receiptId: 'invented' } },
    { ...fx, report: { ...fx.report, stages: fx.report!.stages.slice(1) } },
    { ...fx, uses: { total: 0, returned: 1, quality: 'unverified' } },
  ]) {
    expect(
      parseProductionDetail(
        JSON.stringify({ ok: true, desktopView: view }),
        fx.versionId,
        fx.workspaceId,
      ).ok,
    ).toBe(false)
  }
  expect(
    parseProductionDetail(
      JSON.stringify({ ok: true, plan: 'old-cli' }),
      fx.versionId,
      fx.workspaceId,
    ).ok,
  ).toBe(false)
  expect(
    parseProductionList(JSON.stringify({ ...productionListFixture(), items: [fx, fx], total: 2 }))
      .ok,
  ).toBe(false)
})
it('passes only an exact reviewed activation through argv and has a separate bounded verification authorization', async () => {
  const calls: Parameters<ProcessService['spawn']>[0][] = []
  const process = {
    async spawn(options: Parameters<ProcessService['spawn']>[0]) {
      calls.push(options)
      options.onOutput('{"ok":true}')
      options.onExit?.({ id: 'owned', pid: 1, code: 0, signal: null })
      return { id: 'owned', pid: 1, label: options.label, command: options.command }
    },
    stop: async () => {},
  }
  const runtime = { ...paths, process },
    signal = new AbortController().signal
  expect(
    (
      await runProductionAction(
        runtime,
        { kind: 'activate', versionId: fx.versionId, reviewId: 'latest' },
        signal,
      )
    ).ok,
  ).toBe(false)
  expect(calls).toHaveLength(0)
  expect(
    (
      await runProductionAction(
        runtime,
        {
          kind: 'activate',
          versionId: fx.versionId,
          reviewId: fx.review.status === 'available' ? fx.review.reviewId : '',
        },
        signal,
      )
    ).ok,
  ).toBe(true)
  expect(calls[0]?.args.slice(-6)).toEqual([
    'tools',
    'production-activate',
    fx.versionId,
    '--json',
    '--approve',
    `production-review_v1_${'e'.repeat(64)}`,
  ])
  expect(
    (await runProductionAction(runtime, { kind: 'verify', versionId: fx.versionId }, signal)).ok,
  ).toBe(true)
  expect(calls[1]?.args.slice(-6)).toEqual([
    'tools',
    'production-verify',
    fx.versionId,
    '--json',
    '--allow-tools',
    'run_shell',
  ])
})
it('preserves a stale-review refusal and does not retry a mutation or turn unavailable inventory into an empty list', async () => {
  let calls = 0
  const process = {
    async spawn(options: Parameters<ProcessService['spawn']>[0]) {
      calls++
      options.onOutput('{"ok":false,"code":"production_review_stale"}')
      options.onExit?.({ id: 'owned', pid: 1, code: 52, signal: null })
      return { id: 'owned', pid: 1, label: options.label, command: options.command }
    },
    stop: async () => {},
  }
  const runtime = { ...paths, process },
    signal = new AbortController().signal
  expect(
    await runProductionAction(
      runtime,
      {
        kind: 'activate',
        versionId: fx.versionId,
        reviewId: `production-review_v1_${'e'.repeat(64)}`,
      },
      signal,
    ),
  ).toEqual({ ok: false, reason: 'production_review_stale' })
  expect(calls).toBe(1)
  expect((await loadProductionList(runtime, signal)).ok).toBe(false)
  expect(calls).toBe(2)
})
