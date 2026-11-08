import { describe, expect, it, vi } from 'vitest'
import { createNativeSkillFacade } from './native-skill-facade'
import { createNullLearningPort } from './learning-port'
import type { CliCommandInput, CliCommandResult } from '../host-adapter/cli-command'

function fixture() {
  const base = createNullLearningPort(),
    calls: CliCommandInput[] = []
  base.health = vi.fn(async () => ({
    ok: true,
    available: true,
    storageRoot: 'D:/native-app-data/Trylo',
  }))
  base.listPending = vi.fn(async () => ({
    ok: true,
    pending: [
      { subsystem: 'memory', id: 'memory-pending' },
      { subsystem: 'skills', id: 'old-skill' },
    ],
    count: 2,
  }))
  base.pendingDetail = vi.fn(async () => ({ ok: true, detail: { id: 'memory-pending' } }))
  base.reviewImplicit = vi.fn()
  base.learnExplicit = vi.fn()
  const execute = vi.fn(async (input: CliCommandInput): Promise<CliCommandResult> => {
    calls.push(input)
    if (input.args[2] === 'issues')
      return {
        ok: true as const,
        stdout: JSON.stringify({ schemaVersion: 1, subsystem: 'skill', control: 'issues', ok: true, jobs: [{ jobId: 'skill-job', domain: 'skill', state: 'running' }] }),
      }
    if (input.args[2] === 'explicit')
      return {
        ok: true as const,
        stdout: JSON.stringify({
          schemaVersion: 1, subsystem: 'skill',
          status: 'completed',
          usage: { calls: 1, usageStatus: 'reported', outputTokens: 100 },
          legacyReply: { status: 'staged', candidateId: 'actual-candidate', pendingIds: ['pending-a', 'pending-b'], pendingId: 'pending-a' },
        }),
      }
    const method = input.args[3],
      params: unknown = JSON.parse(input.stdin ?? '{}')
    const body =
      method === 'pendingList'
        ? {
            ok: true,
            pending: [
              { subsystem: 'skills', id: 'native-pending' },
              { subsystem: 'memory', id: 'native-memory' },
            ],
          }
        : method === 'skillsQuery'
          ? { ok: true, skills: [{ name: 'approved-skill' }] }
          : method === 'pendingDetail'
            ? {
                ok: true,
                detail: {
                  id: 'native-pending',
                  expectedHash: 'native-hash',
                  content: 'native-content',
                },
              }
            : method === 'pendingBackupList'
              ? { ok: true, backups: [{ snapshotId: 'native-snapshot' }] }
              : { ok: true, result: { params, committed: true } }
    return {
      ok: true as const,
      stdout: JSON.stringify({ schemaVersion: 1, subsystem: 'skill', method, body }),
    }
  })
  const source = vi.fn(async () => ({ sessionId: 'desktop-canonical' }))
  const options = {
    runtime: () => ({
      process: { spawn: vi.fn(), stop: vi.fn() },
      cliPath: 'new-cli.js',
      cwd: 'D:/repo',
    }),
    explicitAllowance: () => ({ maxCalls: 4, maxOutputTokens: 8000 }),
    source,
    execute,
  }
  return { base, calls, execute, options, source, port: createNativeSkillFacade(base, options) }
}

describe('native skill facade', () => {
  it('uses total-token central authorization and the same native store for explicit learning without a v1 fallback', async () => {
    const h = fixture()
    const allowance = { schemaVersion: 2 as const, unit: 'total_model_tokens' as const,
      maxTokens: 128000, maxCalls: 16, maxSteps: 16, maxPromptChars: 100000 }
    h.execute.mockImplementation(async input => { h.calls.push(input);return { ok: true, stdout: JSON.stringify({ schemaVersion: 1, domain: 'central',
      status: 'completed', result: null, pending: [{ subsystem: 'skills', id: 'confirmed-central-pending' }] }) } })
    const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => allowance })
    expect(await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '保留修复步骤' }))
      .toMatchObject({ ok: true, status: 'staged', pendingIds: ['confirmed-central-pending'] })
    expect(h.calls[0]?.args).toEqual(['learn', 'central', 'skill', '-'])
    expect(JSON.parse(h.calls[0]?.stdin ?? '{}')).toMatchObject({ sessionId: 'desktop-canonical', allowance })
    expect(h.calls[0]?.env).toEqual({ TRYLO_HERMES_STORAGE_ROOT: 'D:/native-app-data/Trylo' })
    h.execute.mockImplementation(async input => { h.calls.push(input);return { ok: false, reason: 'unavailable', stdout: '' } })
    expect((await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '继续' })).ok).toBe(false)
    expect(h.calls.every(call => call.args[1] === 'central')).toBe(true)
    expect(h.calls).toHaveLength(2)
    expect(h.base.learnExplicit).not.toHaveBeenCalled()
  })

  it('a central completed envelope without a qualified receipt remains waiting', async () => {
    const h = fixture()
    h.execute.mockImplementation(async () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 1, domain: 'central',
      status: 'completed', result: null, pending: [] }) }))
    const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => ({ schemaVersion: 2,
      unit: 'total_model_tokens', maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 }) })
    expect(await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '提取' }))
      .toMatchObject({ ok: true, status: 'waiting' })
  })

  it('uses the current pending list authoritatively and falls back only when that field is absent', async () => {
    for (const explicitList of [true, false]) {
      const h = fixture()
      h.execute.mockImplementation(async () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 1, domain: 'central',
        status: 'completed', ...(explicitList ? { pending: [] } : {}),
        result: { status: 'dispatched', result: { ok: true, result: { kind: 'completed',
          resultRefs: ['hermes-pending:skills:historical-proposal'] } } } }) }))
      const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => ({ schemaVersion: 2,
        unit: 'total_model_tokens', maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 }) })
      const reply = await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '核对来源' })
      expect(reply.status).toBe(explicitList ? 'waiting' : 'staged')
      expect(reply.pendingIds).toEqual(explicitList ? undefined : ['historical-proposal'])
    }
  })

  it.each([
    ['central_learning_no_new_investment', 'no_learning'],
    ['central_skill_already_applied', 'completed'],
  ])('maps the explicit terminal reason %s without reviving past proposals', async (reason, status) => {
    const h = fixture()
    h.execute.mockImplementation(async () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 1, domain: 'central',
      status: 'completed', reason, pending: [], result: { result: { ok: true, result: { kind: 'completed',
        resultRefs: ['hermes-pending:skills:already-handled'] } } } }) }))
    const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => ({ schemaVersion: 2,
      unit: 'total_model_tokens', maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 }) })
    expect(await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '检查是否还需学习' }))
      .toEqual({ ok: true, status, reason })
  })

  it.each(['failed', 'cancelled'])('keeps a confirmed partial proposal after a nonzero %s CLI exit', async status => {
    const h = fixture()
    h.execute.mockImplementation(async () => ({ ok: false, reason: status === 'cancelled' ? 'cancelled' : 'exit_1',
      stdout: JSON.stringify({ schemaVersion: 1, domain: 'central', status, reason: 'native_partial_result',
        pending: [{ subsystem: 'skills', id: 'actual-partial' }],
        result: { result: { ok: true, result: { kind: 'failed', resultRefs: ['hermes-pending:skills:stale-history'] } } } }) }))
    const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => ({ schemaVersion: 2,
      unit: 'total_model_tokens', maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 }) })
    expect(await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '保留已确认部分' }))
      .toEqual({ ok: false, status, reason: 'native_partial_result', pendingId: 'actual-partial', pendingIds: ['actual-partial'] })
  })

  it('does not accept a completed label from a failed transport', async () => {
    const h = fixture()
    h.execute.mockImplementation(async () => ({ ok: false, reason: 'exit_1', stdout: JSON.stringify({
      schemaVersion: 1, domain: 'central', status: 'completed', pending: [{ subsystem: 'skills', id: 'unconfirmed-success' }], result: null }) }))
    const port = createNativeSkillFacade(h.base, { ...h.options, centralAllowance: () => ({ schemaVersion: 2,
      unit: 'total_model_tokens', maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 }) })
    const result = await port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '核对真实完成' })
    expect(result).toMatchObject({ ok: false, status: 'failed' })
    expect(result.pendingIds).toBeUndefined()
  })

  it('rejects a foreign or unsupported execution envelope instead of claiming learning completed', async () => {
    const h = fixture()
    h.execute.mockImplementation(async () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 2, subsystem: 'tool', status: 'completed', legacyReply: { status: 'staged' } }) }))
    expect(await h.port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'c', learnRequest: 'Learn' }))
      .toMatchObject({ ok: false, status: 'failed', reason: 'native_skill_response_invalid' })
    expect(await h.port.runStatus({ workspaceRoot: 'D:/repo' })).toMatchObject({ ok: false, active: false })
  })

  it('keeps every confirmed pending locator and reports transport cancellation accurately', async () => {
    const h = fixture()
    expect(await h.port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'c', learnRequest: 'Learn' }))
      .toMatchObject({ ok: true, status: 'staged', pendingId: 'pending-a', pendingIds: ['pending-a', 'pending-b'] })
    h.execute.mockImplementation(async () => ({ ok: false, reason: 'cancelled' }))
    expect(await h.port.learnExplicit({ workspaceRoot: 'D:/repo', sessionId: 'c', learnRequest: 'Learn' }))
      .toMatchObject({ ok: false, status: 'cancelled', reason: 'cancelled' })
  })
  it('uses native assets and exact hash approvals while Memory keeps its original owner', async () => {
    const h = fixture()
    expect((await h.port.skills({ op: 'list' })).skills).toEqual([{ name: 'approved-skill' }])
    expect(h.calls[0]?.env).toEqual({ TRYLO_HERMES_STORAGE_ROOT: 'D:/native-app-data/Trylo' })
    expect((await h.port.listPending()).pending.map((item) => item.id)).toEqual([
      'memory-pending',
      'native-pending',
    ])
    await h.port.pendingDetail({ subsystem: 'memory', id: 'memory-pending' })
    expect(h.base.pendingDetail).toHaveBeenCalledWith({ subsystem: 'memory', id: 'memory-pending' })
    expect(
      (await h.port.pendingDetail({ subsystem: 'skills', id: 'native-pending' })).detail
        ?.expectedHash,
    ).toBe('native-hash')
    const params = {
      subsystem: 'skills' as const,
      id: 'native-pending',
      expectedHash: 'native-hash',
    }
    expect((await h.port.applyPending(params)).ok).toBe(true)
    expect(JSON.parse(h.calls.at(-1)?.stdin ?? '{}')).toEqual(params)
    expect((await h.port.listPendingBackups()).backups).toEqual([{ snapshotId: 'native-snapshot' }])
    await h.port.rollbackPending({ snapshotId: 'native-snapshot' })
    expect(JSON.parse(h.calls.at(-1)?.stdin ?? '{}')).toEqual({ snapshotId: 'native-snapshot' })
  })

  it('fails closed on a missing reviewed hash and a failed native backend without returning old skills', async () => {
    const h = fixture()
    expect((await h.port.applyPending({ subsystem: 'skills', id: 'p', expectedHash: '' })).ok).toBe(
      false,
    )
    expect(h.calls).toHaveLength(0)
    h.execute.mockImplementation(async () => ({ ok: false, reason: 'native-runtime-unavailable' }))
    expect((await h.port.skills({ op: 'list' })).ok).toBe(false)
    expect((await h.port.listPending()).pending).toEqual([
      { subsystem: 'memory', id: 'memory-pending' },
    ])
  })

  it('maps explicit learning to the exact canonical session with output allowance and no renderer evidence', async () => {
    const h = fixture(),
      params = {
        workspaceRoot: 'D:/repo',
        sessionId: 'renderer-conversation',
        learnRequest: 'Retain the revised process.',
        resultText: 'Untrusted renderer summary',
      }
    expect(await h.port.learnExplicit(params)).toMatchObject({
      ok: true,
      status: 'staged',
      candidateId: 'actual-candidate',
    })
    expect(h.source).toHaveBeenCalledWith(params)
    expect(JSON.parse(h.calls[0]?.stdin ?? '{}')).toEqual({
      workspaceRoot: 'D:/repo',
      sessionId: 'desktop-canonical',
      learnRequest: params.learnRequest,
      allowance: { maxCalls: 4, maxOutputTokens: 8000 },
    })
    expect(h.base.learnExplicit).not.toHaveBeenCalled()
    expect((await h.port.reviewImplicit(params)).status).toBe('skipped')
    expect(h.base.reviewImplicit).not.toHaveBeenCalled()
  })

  it('rejects source-less learning and reads status from canonical skill jobs', async () => {
    const h = fixture(),
      port = createNativeSkillFacade(h.base, { ...h.options, source: async () => undefined })
    expect(
      (
        await port.learnExplicit({
          workspaceRoot: 'D:/repo',
          sessionId: 'missing',
          learnRequest: 'Learn',
        })
      ).reason,
    ).toBe('canonical_skill_source_unavailable')
    expect(h.calls).toHaveLength(0)
    expect(await port.runStatus({ workspaceRoot: 'D:/repo' })).toMatchObject({
      ok: true,
      active: true,
      run: { mode: 'skill', status: 'running' },
    })
  })

  it('refuses to choose a different native home when the real Desktop namespace is unavailable', async () => {
    const h = fixture()
    h.base.health = async () => ({ ok: false, available: false, reason: 'service unavailable' })
    expect(await h.port.skills({ op: 'list' })).toMatchObject({
      ok: false,
      error: 'native_skill_storage_unavailable',
    })
    expect(h.calls).toHaveLength(0)
  })
})
