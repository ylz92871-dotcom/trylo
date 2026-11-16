import { describe, expect, it } from 'vitest'
import { projectCollaboration } from './remote-collaboration'
import { applyEvents } from '../components/chat/events'
import type { ChatMessage, SubagentMessage } from '../components/chat/types'

describe('mobile collaboration projection', () => {
  it('restores the canonical child identity and round history without inventing queued members', () => {
    const child: SubagentMessage = {
      id: 'ui-row',
      subagentId: 'child-42',
      kind: 'subagent',
      role: 'assistant',
      createdAt: 1,
      status: 'done',
      agentType: 'worker',
      displayName: '实现',
      prompt: 'Build the UI',
      result: 'Done',
      conversation: [
        { round: 1, prompt: 'Build', result: 'Draft' },
        { round: 2, prompt: 'Revise', result: 'Done' },
      ],
    }
    const state = projectCollaboration({
      messages: [child],
      run: null,
      enabled: true,
      profiles: [],
    })
    expect(state.members).toEqual([
      {
        id: 'ui-row',
        name: '实现',
        status: 'done',
        prompt: 'Build the UI',
        result: 'Done',
        error: undefined,
        durationMs: undefined,
        rounds: [
          { round: 1, prompt: 'Build', result: 'Draft' },
          { round: 2, prompt: 'Revise', result: 'Done' },
        ],
      },
    ])
    expect(state.team).toBeNull()
    expect(
      projectCollaboration({ messages: [], run: null, enabled: false, profiles: [] }).members,
    ).toEqual([])
  })
  it('keeps one member and both rounds when the Desktop reducer resumes a child', () => {
    const initial: ChatMessage[] = [
      { id: 'user', kind: 'text', role: 'user', text: 'Review', createdAt: 0 },
    ]
    const messages = applyEvents(initial, [
      {
        type: 'subagent',
        seq: 1,
        ts: 1,
        id: 'invoke-1',
        taskId: 'task',
        kind: 'spawn',
        source: 'trylo-v1',
        agentType: 'general-purpose',
        prompt: 'First task',
      },
      {
        type: 'subagent',
        seq: 2,
        ts: 2,
        id: 'invoke-1',
        taskId: 'task',
        kind: 'end',
        result: 'First reply',
      },
    ])
    const first = projectCollaboration({ messages, run: null, profiles: [], enabled: true })
    const resumed = applyEvents(messages, [
      {
        type: 'subagent',
        seq: 3,
        ts: 3,
        id: 'invoke-2',
        taskId: 'task',
        resumedFrom: 'invoke-1',
        round: 2,
        kind: 'spawn',
        source: 'trylo-v1',
        agentType: 'general-purpose',
        prompt: 'Revise',
      },
      {
        type: 'subagent',
        seq: 4,
        ts: 4,
        id: 'invoke-2',
        taskId: 'task',
        round: 2,
        kind: 'end',
        result: 'Second reply',
      },
    ])
    const second = projectCollaboration({
      messages: resumed,
      run: null,
      profiles: [],
      enabled: true,
    })
    expect(second.members).toHaveLength(1)
    expect(second.members[0]?.id).toBe(first.members[0]?.id)
    expect(second.members[0]?.rounds).toEqual([
      { round: 1, prompt: 'First task', result: 'First reply' },
      { round: 2, prompt: 'Revise', result: 'Second reply' },
    ])
  })
})
