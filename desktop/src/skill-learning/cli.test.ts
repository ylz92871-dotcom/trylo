import { expect, it } from 'vitest'
import type { ProcessService } from '../host-adapter/process-service'
import type { FilePath } from '../host-adapter/types'
import { createSkillLearningPort } from './cli'
import { codePermissionFlagsForV1 } from '../permission/permission-policy'

const skill = {
  versionId: 'version-1',
  proposalId: 'proposal-1',
  name: 'report-method',
  version: 1,
  status: 'shadow',
  createdAt: '2026-11-03T00:00:00.000Z',
  sourceOpportunityId: 'opportunity-1',
  observationRefs: ['episode-1'],
  contentHash: 'hash-1',
  taskFamily: { id: 'report', intentClass: 'normalize_report', checkKind: 'acceptance' },
  usage: { loads: 1, successes: 0, failures: 0 },
}

function harness(reply: unknown, code = 0, trialAuthorized = false) {
  const calls: Parameters<ProcessService['spawn']>[0][] = []
  const process: Pick<ProcessService, 'spawn' | 'stop'> = {
    async spawn(options) {
      calls.push(options)
      options.onOutput(JSON.stringify(reply))
      options.onExit?.({ id: 'skill-command', pid: 1, code, signal: null })
      return { id: 'skill-command', pid: 1, label: options.label, command: options.command }
    },
    stop: async () => {},
  }
  return {
    calls,
    port: createSkillLearningPort({
      process,
      cliPath: 'D:/cli/main.js' as FilePath,
      cwd: 'D:/workspace' as FilePath,
      nodeProgram: 'D:/node.exe',
      trialAuthorized,
    }),
  }
}

it('reads the CLI-owned versioned projection through the selected runtime and rejects corrupt or old replies', async () => {
  const payload = { schemaVersion: 1, ok: true, workspaceId: 'workspace-1', skills: [skill] }
  const h = harness(payload),
    signal = new AbortController().signal
  expect(await h.port.list(signal)).toEqual({
    ok: true,
    workspaceId: 'workspace-1',
    skills: [skill],
  })
  expect(h.calls[0]?.command).toBe('D:/node.exe')
  expect(h.calls[0]?.args.slice(-3)).toEqual(['skills', 'list', '--json'])
  expect(h.calls[0]?.cwd).toBe('D:/workspace')
  for (const value of [
    { ...payload, schemaVersion: 2 },
    { ...payload, skills: [skill, skill] },
    { ...payload, skills: [{ ...skill, usage: { loads: -1, successes: 0, failures: 0 } }] },
    { ok: true, skills: [] },
  ]) {
    expect((await harness(value).port.list(signal)).ok).toBe(false)
  }
})

it('binds immutable versions and reuses Desktop shell isolation without implicit trial authorization', async () => {
  const signal = new AbortController().signal
  expect(
    (
      await harness({ schemaVersion: 1, ok: true, skill, content: 'body', uses: [] }).port.show(
        'wrong-version',
        signal,
      )
    ).ok,
  ).toBe(false)
  expect(
    (
      await harness({
        schemaVersion: 1,
        ok: true,
        versionId: 'wrong-version',
        status: 'withdrawn',
      }).port.withdraw(skill.versionId, signal)
    ).ok,
  ).toBe(false)
  const h = harness({
    schemaVersion: 1,
    ok: true,
    result: { status: 'waiting', reason: 'needs_evidence', usage: { tokens: 0, calls: 0 } },
  })
  expect((await h.port.learn({ maxTokens: 2000, maxCalls: 2 }, signal)).ok).toBe(true)
  const runFlags = codePermissionFlagsForV1('workspace_write')
  expect(h.calls[0]?.args.slice(1)).toEqual([
    'skills',
    'learn',
    '--max-tokens',
    '2000',
    '--max-calls',
    '2',
    '--shell-isolation',
    runFlags[runFlags.indexOf('--shell-isolation') + 1],
    '--json',
  ])
  expect(h.calls[0]?.args).not.toContain('--allow-exec')
  expect(h.calls[0]?.args).not.toContain('--allow-writes')
  expect(h.calls[0]?.args).not.toContain('--allow-skill-trial')
  const authorized = harness(
    {
      schemaVersion: 1,
      ok: true,
      result: {
        status: 'waiting',
        reason: 'needs_evidence',
        usage: { calls: 1, usageStatus: 'missing' },
      },
    },
    0,
    true,
  )
  const learned = await authorized.port.learn({ maxTokens: 12000, maxCalls: 12 }, signal)
  expect(authorized.calls[0]?.args).toContain('--allow-writes')
  expect(authorized.calls[0]?.args).toContain('--allow-exec')
  expect(authorized.calls[0]?.args).toContain('--allow-skill-trial')
  expect(learned.ok && learned.usage).toEqual({ calls: 1, usageStatus: 'missing' })
  expect(
    await harness(
      { schemaVersion: 1, ok: false, code: 'collection_disabled', message: 'closed' },
      6,
    ).port.list(signal),
  ).toEqual({ ok: false, reason: 'collection_disabled' })
})
