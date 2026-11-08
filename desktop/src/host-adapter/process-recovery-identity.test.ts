import { expect, it } from 'vitest'
import {
  isConversationRecoveryIdentity,
  isTeamRecoveryIdentity,
  processRecoveryIdentityKey,
  readProcessRecoveryIdentity,
  sameProcessRecoveryIdentity,
} from './process-recovery-identity'
import { recoveryProcesses, retainedProcessOutput } from './process-recovery-snapshot'

it('decodes ordinary ownership without creating a team identity', () => {
  const identity = readProcessRecoveryIdentity({
    kind: 'conversation',
    runId: 'run',
    turnId: 'turn',
  })
  expect(identity).toEqual({ kind: 'conversation', runId: 'run', turnId: 'turn' })
  expect(identity).not.toHaveProperty('teamRunId')
  expect(identity && isConversationRecoveryIdentity(identity)).toBe(true)
  expect(identity && isTeamRecoveryIdentity(identity)).toBe(false)
})

it('preserves existing team wire and compares it with an explicitly tagged team', () => {
  const old = { teamRunId: 'team', turnId: 'turn' }
  const tagged = { kind: 'team' as const, ...old }
  expect(readProcessRecoveryIdentity(old)).toEqual(old)
  expect(readProcessRecoveryIdentity(tagged)).toEqual(tagged)
  expect(sameProcessRecoveryIdentity(old, tagged)).toBe(true)
  expect(isTeamRecoveryIdentity(old)).toBe(true)
})

it.each([
  { kind: 'conversation', turnId: 'turn' },
  { kind: 'conversation', runId: '', turnId: 'turn' },
  { kind: 'conversation', runId: 'run', turnId: '   ' },
  { kind: 'conversation', runId: 'run', turnId: 'turn', teamRunId: 'team' },
  { kind: 'unknown', teamRunId: 'team', turnId: 'turn' },
  { kind: 'team', teamRunId: 'team', turnId: 'turn', runId: 'run' },
  { runId: 'run', turnId: 'turn' },
])('rejects ambiguous or incomplete recovery ownership %j', (value) => {
  expect(readProcessRecoveryIdentity(value)).toBeNull()
})

it('separates turns and run identities across recovery kinds', () => {
  const ordinary = { kind: 'conversation' as const, runId: 'shared', turnId: 'turn' }
  const team = { teamRunId: 'shared', turnId: 'turn' }
  expect(sameProcessRecoveryIdentity(ordinary, team)).toBe(false)
  expect(processRecoveryIdentityKey(ordinary)).not.toBe(
    processRecoveryIdentityKey({ ...ordinary, runId: 'other' }),
  )
  expect(sameProcessRecoveryIdentity(ordinary, { ...ordinary, turnId: 'other' })).toBe(false)
})

it('accepts ordinary retained pages through the real process snapshot boundary', () => {
  const process = {
    id: 'root',
    pid: 123,
    projectKey: 'workspace',
    conversationId: 'chat',
    identity: { kind: 'conversation', runId: 'run', turnId: 'turn' },
  }
  expect(recoveryProcesses([process])).toEqual([process])
  expect(
    retainedProcessOutput({
      version: 1,
      process,
      records: [],
      nextSequence: 0,
      hasMore: false,
      gap: false,
      finished: false,
      captureComplete: true,
      exit: null,
      answeredRequests: [],
    }).process,
  ).toEqual(process)
})
