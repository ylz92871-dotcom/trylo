import type { ChatMessage } from '../components/chat/types'
import type { RemoteCollaborationState, RemoteMember } from '../services-host/methods'
import type { PersistableTeamRun } from '../user-learning/team-access/persist'
import type { TeamRun } from '../surfaces/team/team-types'
import type { TeamProfile } from '../user-learning/team-access/profiles/profile-types'

/** Wire projections only. Desktop history and Team Access retain ownership. */
export function projectMember(message: Extract<ChatMessage, { kind: 'subagent' }>): RemoteMember {
  return {
    id: message.id,
    name: message.displayName || message.agentType,
    status: message.status,
    prompt: message.prompt || '',
    result: message.result || message.summary || '',
    error: message.error,
    durationMs: message.durationMs,
    rounds: message.conversation?.map((round) => ({
      round: round.round,
      prompt: round.prompt || '',
      result: round.result || '',
    })),
  }
}

export function projectCollaboration(input: {
  messages: readonly ChatMessage[]
  run: TeamRun | PersistableTeamRun | null
  profiles: readonly TeamProfile[]
  enabled: boolean
}): RemoteCollaborationState {
  const members = new Map<string, RemoteMember>()
  const invocations = new Set<string>()
  for (const message of input.messages)
    if (message.kind === 'subagent') {
      invocations.add(message.subagentId || message.id)
      const member = projectMember(message)
      members.set(member.id, member)
    }
  // Seats represent actual on-stage members; configured profile roles are never progress rows.
  if (input.run)
    for (const seat of input.run.seats) {
      if (seat.status === 'queued' || invocations.has(seat.id)) continue
      const id = `team:${input.run.id}:${seat.memberId || seat.id}`
      if (!members.has(id))
        members.set(id, {
          id,
          name: seat.displayName || seat.seat,
          status:
            seat.status === 'completed'
              ? 'done'
              : seat.status === 'waiting_approval'
                ? 'waiting'
                : seat.status,
          prompt: seat.prompt || '',
          result: seat.result || seat.summary || '',
          error: seat.error,
          durationMs: seat.durationMs,
          rounds: seat.conversation?.map((round) => ({
            round: round.round,
            prompt: round.prompt || '',
            result: round.result || '',
          })),
        })
    }
  return {
    canStartTeam: input.enabled,
    profiles: input.profiles.map((profile) => ({
      id: profile.id,
      title: profile.title,
      members: profile.members.map((member) => member.displayName),
    })),
    members: [...members.values()],
    team: input.run
      ? {
          id: input.run.id,
          status: input.run.status,
          title: input.run.frozenProfile?.title || input.run.summary.title,
        }
      : null,
  }
}
