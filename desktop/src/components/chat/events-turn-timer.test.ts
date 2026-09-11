import { describe, expect, it } from 'vitest'
import { applyEvents } from './events'
import type { ChatMessage, TextMessage } from './types'
import type { LoopEndEvent, TextEvent, ToolUseEvent } from '../../host-adapter/loop-events'

const userTurn: ChatMessage = {
  id: 'u1',
  kind: 'text',
  role: 'user',
  createdAt: 1000,
  text: 'hello',
  turnStartedAt: 1000,
}

describe('per-turn timer finalization', () => {
  it('freezes on a tool when the model emits no text or thinking first', () => {
    const event: ToolUseEvent = {
      type: 'tool_use',
      seq: 1,
      ts: 1500,
      turn: 1,
      id: 'tool-1',
      tool: 'Read',
      input: { file_path: 'a.ts' },
    }
    const out = applyEvents([userTurn], [event])
    expect((out[0] as TextMessage).finalElapsedMs).toBe(500)
  })

  it('freezes on loop_end when a run produced no visible output', () => {
    const event: LoopEndEvent = {
      type: 'loop_end',
      seq: 1,
      ts: 2500,
      durationMs: 1500,
      totalCost: 0,
      numTurns: 0,
      reason: 'cancelled',
      finalResult: '',
    }
    const out = applyEvents([userTurn], [event])
    expect((out[0] as TextMessage).finalElapsedMs).toBe(1500)
  })

  it('ignores empty text protocol frames', () => {
    const event: TextEvent = {
      type: 'text',
      seq: 1,
      ts: 1200,
      turn: 1,
      preview: '',
      fullText: '',
      partial: true,
    }
    const out = applyEvents([userTurn], [event])
    expect(out).toHaveLength(1)
    expect((out[0] as TextMessage).finalElapsedMs).toBeUndefined()
  })
})
