import { expect, it, vi } from 'vitest'
import type { CliCommandInput } from '../host-adapter/cli-command'
import type { FilePath } from '../host-adapter/types'
import { createCollaborationIssuesClient, parseCollaborationIssues } from './issues-cli'
import { createDesktopLibraryClients } from './library-clients'

const runtime = {
  cwd: 'D:/workspace' as FilePath,
  cliPath: 'D:/cli/main.js' as FilePath,
  process: { spawn: vi.fn(), stop: vi.fn() },
}
const snapshot = {
  schemaVersion: 1,
  scope: runtime.cwd,
  issues: [
    {
      issueId: 'issue-a',
      revision: 3,
      title: '交接问题',
      decision: 'unreviewed',
      updatedAt: '2026-11-03',
      reports: [
        {
          reportId: 'report-a',
          memberId: 'member-a',
          facts: ['缺少单位'],
          suspectedCauses: [],
          evidenceRefs: [],
        },
      ],
      dependencies: [],
      adjustments: [],
      feedback: [],
    },
  ],
}
it('sends the canonical scope, CAS command and bounded signal through the existing process transport', async () => {
  const run = vi.fn(async (input: CliCommandInput) => ({
    ok: true as const,
    stdout: JSON.stringify(input.stdin ? { schemaVersion: 1, ok: true, revision: 4 } : snapshot),
  }))
  const client = createCollaborationIssuesClient(runtime, run),
    signal = new AbortController().signal
  expect(await client.read(runtime.cwd, signal)).toEqual(snapshot)
  const command = {
    schemaVersion: 1 as const,
    action: 'resolve' as const,
    issueId: 'issue-a',
    expectedRevision: 3,
    reason: '成员已同步并确认。',
  }
  expect(await client.resolve(runtime.cwd, command, signal)).toEqual({
    schemaVersion: 1,
    ok: true,
    revision: 4,
  })
  expect(run.mock.calls[0]?.[0]).toEqual({
    ...runtime,
    args: ['learn', 'collaboration', 'issues', '--workspace', runtime.cwd, '--json'],
    signal,
    timeoutMs: 30000,
  })
  expect(run.mock.calls[1]?.[0]).toEqual({
    ...runtime,
    args: ['learn', 'collaboration', 'coordinate', '--workspace', runtime.cwd, '-'],
    stdin: `${JSON.stringify(command)}\n`,
    signal,
    timeoutMs: 30000,
  })
})
it('rejects corrupted nested fields, foreign scope, invalid accounting and unconfirmed receipts', async () => {
  expect(() =>
    parseCollaborationIssues(JSON.stringify({ ...snapshot, scope: 'D:/foreign' }), runtime.cwd),
  ).toThrow()
  expect(() =>
    parseCollaborationIssues(
      JSON.stringify({
        ...snapshot,
        issues: [{ ...snapshot.issues[0], reports: [{ facts: 'not-array' }] }],
      }),
      runtime.cwd,
    ),
  ).toThrow()
  expect(() =>
    parseCollaborationIssues(
      JSON.stringify({
        ...snapshot,
        issues: [
          {
            ...snapshot.issues[0],
            learning: {
              jobId: 'j',
              grantId: 'g',
              state: 'running',
              unit: 'total_model_tokens',
              allowance: 12,
              spent: -1,
              remaining: 12,
            },
          },
        ],
      }),
      runtime.cwd,
    ),
  ).toThrow()
  expect(() =>
    parseCollaborationIssues(JSON.stringify({ ...snapshot, scope: '/Workspace' }), '/workspace'),
  ).toThrow()
  const client = createCollaborationIssuesClient(runtime, async () => ({
    ok: true,
    stdout: '{"schemaVersion":1,"ok":true}',
  }))
  await expect(
    client.resolve(
      runtime.cwd,
      { schemaVersion: 1, action: 'resolve', issueId: 'a', expectedRevision: 0, reason: '确认' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('receipt')
})
it('refuses invalid user commands and mismatched workspace before a process is started', async () => {
  const run = vi.fn(),
    client = createCollaborationIssuesClient(runtime, run),
    signal = new AbortController().signal
  await expect(client.read('D:/foreign', signal)).rejects.toThrow('scope')
  await expect(
    client.resolve(
      runtime.cwd,
      { schemaVersion: 1, action: 'resolve', issueId: 'a', expectedRevision: 3, reason: '   ' },
      signal,
    ),
  ).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})
it('routes original library payloads without inventing a trusted user-action capability', async () => {
  const run = vi.fn(async (input: CliCommandInput) => input.args[1] === 'expert' ? { ok: true as const, stdout: '[]' }
    : { ok: false as const, reason: 'exit_1', stdout: '{"ok":false,"code":"not_found","message":"原库未找到申请"}' })
  const clients = createDesktopLibraryClients(runtime, run),
    signal = new AbortController().signal
  expect(await clients.tools.getRequest({ memberId: 'personal_agent', scope: runtime.cwd }, 'request-a', signal)).toEqual({ ok: false, code: 'not_found', message: '原库未找到申请' });
  await clients.experts.requests(signal)
  expect(run.mock.calls[0]?.[0]).toEqual({
    ...runtime,
    args: ['library', 'tool', '--workspace', runtime.cwd, '-'],
    stdin: `${JSON.stringify({ context: { memberId: 'personal_agent', scope: runtime.cwd }, command: { operation: 'get-request', requestId: 'request-a' } })}\n`,
    signal,
    timeoutMs: 300000,
  })
  expect(run.mock.calls[1]?.[0].stdin).toBe('{"operation":"requests"}\n')
  expect(run.mock.calls[1]?.[0].args).toEqual([
    'library',
    'expert',
    '--workspace',
    runtime.cwd,
    '-',
  ])
  run.mockResolvedValueOnce({ ok: false, reason: 'exit_1', stdout: '{"ok":false,"reason":"store_unavailable"}' });
  await expect(clients.experts.requests(signal)).rejects.toThrow('store_unavailable');
})
