import { expect, it, vi } from 'vitest'
import { RecoveredTeamOutput } from './recovered-team-output'
import type { ProcessService, RecoverableProcess } from '../host-adapter/process-service'
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: { send: vi.fn() } } }))

it('does not treat an expired raw log as missing output for the matching durably settled run', async () => {
  const process: RecoverableProcess = { id: 'p', pid: 1, projectKey: 'project', conversationId: 'chat',
    identity: { kind: 'conversation', runId: 'run', turnId: 'turn' } }
  const readOutput = vi.fn().mockRejectedValue(new Error('Expired retained log'))
  const port: ProcessService = { spawn: vi.fn(), send: vi.fn(), stop: vi.fn(), closeInput: vi.fn(), list: vi.fn().mockResolvedValue([]),
    recoveryList: vi.fn().mockResolvedValue([process]), readOutput }
  const recovery = new RecoveredTeamOutput(() => port, vi.fn(), vi.fn(), vi.fn())
  const result = await recovery.readConversation('project', 'chat', ['turn'], { runId: 'run', turnId: 'turn', settled: true })
  expect(result).toBeNull()
  expect(readOutput).not.toHaveBeenCalled()
})

it('keeps the real recovery check when the matching root is still alive', async () => {
  const process: RecoverableProcess = { id: 'live', pid: 1, projectKey: 'project', conversationId: 'chat',
    identity: { kind: 'conversation', runId: 'run', turnId: 'turn' } }
  const readOutput = vi.fn().mockRejectedValue(new Error('Current live output is unavailable'))
  const port: ProcessService = { spawn: vi.fn(), send: vi.fn(), stop: vi.fn(), closeInput: vi.fn(),
    list: vi.fn().mockResolvedValue([process]), recoveryList: vi.fn().mockResolvedValue([process]), readOutput }
  const recovery = new RecoveredTeamOutput(() => port, vi.fn(), vi.fn(), vi.fn())
  await expect(recovery.readConversation('project', 'chat', ['turn'], { runId: 'run', turnId: 'turn', settled: true }))
    .rejects.toThrow('Current live output is unavailable')
  expect(readOutput).toHaveBeenCalledOnce()
})
