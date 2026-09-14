// Trylo Desktop — host-side §18.3 wrong_window_dispatch_count tests.
//
// The chain under test: fact parsing (targetResultFactsOf, the server's
// trylo-target block — night-run s19 measured schema) → the pure judge
// (wrongWindowDispatchOf) → the counting store, wired through the same
// event-pairing watcher paradigm as createSensitiveWindowWatcher.

import { describe, expect, it } from 'vitest'
import type { ToolResultEvent, ToolUseEvent } from '../host-adapter/loop-events'
import { WINDOWS_SERVER_NAME } from './classifiers/windows-mcp-classifier'
import {
  DesktopDispatchMetrics,
  createWrongWindowDispatchWatcher,
  wrongWindowDispatchOf,
} from './desktop-dispatch-metrics'

const CLICK_TOOL = `mcp__${WINDOWS_SERVER_NAME}__Click`

function toolUse(id: string, input: Record<string, unknown>): ToolUseEvent {
  return {
    type: 'tool_use',
    seq: 1,
    ts: 1,
    turn: 1,
    id,
    tool: CLICK_TOOL,
    input,
  } as never
}

/** A tool_result carrying the trylo-target fact block in the night-run s19
 *  measured schema (channel/dispatch/effect/foregroundDigest/window). */
function dispatchResult(
  id: string,
  windowDigest: string,
  foregroundDigest: string | null,
): ToolResultEvent {
  const facts = `trylo-target:${JSON.stringify({
    channel: 'uia',
    dispatch: 'accepted',
    effect: 'unknown_outcome',
    foregroundDigest,
    window: { hwnd: 42, pid: 4242, digest: windowDigest, title: '记事本' },
  })}`
  return {
    type: 'tool_result',
    seq: 2,
    ts: 2,
    turn: 1,
    id,
    tool: CLICK_TOOL,
    ok: true,
    output: facts,
    durationMs: 1,
  } as never
}

function intentInput(digest: string): Record<string, unknown> {
  return { _target: { window: { hwnd: 42, pid: 4242, digest, title: '记事本' } } }
}

describe('wrongWindowDispatchOf (pure judge)', () => {
  it('flags a dispatch that landed on a non-intended window', () => {
    const judgement = wrongWindowDispatchOf(intentInput('digest-A'), {
      window: { hwnd: 99, pid: 4242, digest: 'digest-B' },
      foregroundDigest: 'digest-B',
    })
    expect(judgement).toMatchObject({
      verdict: 'wrong_window',
      intentDigest: 'digest-A',
      dispatchDigest: 'digest-B',
    })
  })

  it('clears a dispatch that landed on the intended window', () => {
    const judgement = wrongWindowDispatchOf(intentInput('digest-A'), {
      window: { hwnd: 42, pid: 4242, digest: 'digest-A' },
      foregroundDigest: 'digest-other',
    })
    // Foreground elsewhere is legal (handle-targeted dispatch) — the verdict
    // keys on the dispatch receipt, foreground is diagnostic only.
    expect(judgement.verdict).toBe('on_target')
    expect(judgement).toHaveProperty('foregroundDigest', 'digest-other')
  })

  it('reports unjudgeable when the input carries no intent receipt', () => {
    expect(
      wrongWindowDispatchOf(
        { window_name: 'plain model text — never trusted' },
        { window: { hwnd: 42, pid: 4242, digest: 'digest-A' }, foregroundDigest: null },
      ),
    ).toEqual({ verdict: 'unjudgeable', reason: 'no_intent_receipt' })
  })

  it('reports unjudgeable when the result carries no fact block', () => {
    expect(wrongWindowDispatchOf(intentInput('digest-A'), null)).toEqual({
      verdict: 'unjudgeable',
      reason: 'no_dispatch_facts',
    })
  })
})

describe('wrong-window dispatch watcher (§18.3 counting point)', () => {
  it('counts wrong-window dispatches across the event stream', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const outcome = watcher(
      [
        toolUse('u1', intentInput('digest-A')),
        dispatchResult('u1', 'digest-B', 'digest-B'),
        toolUse('u2', intentInput('digest-A')),
        dispatchResult('u2', 'digest-A', 'digest-A'),
      ],
      'conv-1',
    )

    expect(outcome.wrongWindowRecorded).toBe(true)
    expect(outcome.judgements).toHaveLength(2)
    // The dispatchResult fixture omits `effect` (unknown outcome) and both
    // calls share one target, so the second submission is ALSO an unsafe
    // duplicate — exactly the §18.4-3 predicate, counted independently.
    expect(metrics.snapshot()).toEqual({
      wrongWindowDispatchCount: 1,
      onTargetDispatchCount: 1,
      unjudgeableDispatchCount: 0,
      unsafeDuplicateCount: 1,
    })
  })

  it('pairs intent and dispatch across separate event batches', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    watcher([toolUse('u1', intentInput('digest-A'))], 'conv-1')
    watcher([dispatchResult('u1', 'digest-B', null)], 'conv-1')

    expect(metrics.snapshot().wrongWindowDispatchCount).toBe(1)
  })

  it('counts unjudgeable dispatches separately instead of folding them', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    watcher(
      [
        toolUse('u1', { window_name: 'no receipt' }),
        dispatchResult('u1', 'digest-B', null),
        toolUse('u2', intentInput('digest-A')),
        {
          type: 'tool_result',
          seq: 9,
          ts: 9,
          turn: 1,
          id: 'u2',
          tool: CLICK_TOOL,
          ok: false,
          output: 'no fact block in this output',
          durationMs: 1,
        } as never,
      ],
      'conv-1',
    )

    expect(metrics.snapshot()).toEqual({
      wrongWindowDispatchCount: 0,
      onTargetDispatchCount: 0,
      unjudgeableDispatchCount: 2,
      unsafeDuplicateCount: 0,
    })
  })

  it('ignores tools outside the windows-MCP server', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const outcome = watcher(
      [
        {
          type: 'tool_use',
          seq: 1,
          ts: 1,
          turn: 1,
          id: 'u1',
          tool: 'mcp__trylo-chrome__navigate',
          input: intentInput('digest-A'),
        } as never,
        dispatchResult('u1', 'digest-B', null),
      ],
      'conv-1',
    )

    expect(outcome.judgements).toHaveLength(0)
    expect(metrics.snapshot()).toEqual({
      wrongWindowDispatchCount: 0,
      onTargetDispatchCount: 0,
      unjudgeableDispatchCount: 0,
      unsafeDuplicateCount: 0,
    })
  })
})

// ── unsafe_duplicate_count (§18.4-3, host intent layer) ─────────────────────

function typeUse(id: string, input: Record<string, unknown>, tool = CLICK_TOOL): ToolUseEvent {
  return { type: 'tool_use', seq: 1, ts: 1, turn: 1, id, tool, input } as never
}

function effectResult(id: string, effect: string | null): ToolResultEvent {
  const facts =
    effect === null
      ? 'plain output — no fact block'
      : `trylo-target:${JSON.stringify({
          dispatch: 'accepted',
          effect,
          window: { hwnd: 42, pid: 4242, digest: 'digest-A', title: '记事本' },
        })}`
  return {
    type: 'tool_result',
    seq: 2,
    ts: 2,
    turn: 1,
    id,
    tool: CLICK_TOOL,
    ok: true,
    output: facts,
    durationMs: 1,
  } as never
}

describe('unsafe duplicate submissions (§18.4-3)', () => {
  it('counts a resubmission while the prior same-target call is in flight', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const click = { x: 10, y: 20, _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-A' } } }
    watcher([typeUse('u1', click)], 'conv-1')
    const outcome = watcher([typeUse('u2', click)], 'conv-1')

    expect(outcome.unsafeDuplicateRecorded).toBe(true)
    expect(metrics.snapshot().unsafeDuplicateCount).toBe(1)
  })

  it('counts a resubmission after an unknown-outcome completion', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const click = { x: 10, y: 20, _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-A' } } }
    watcher([typeUse('u1', click), effectResult('u1', 'unknown_outcome')], 'conv-1')
    watcher([typeUse('u2', click)], 'conv-1')

    expect(metrics.snapshot().unsafeDuplicateCount).toBe(1)
  })

  it('allows resubmission after a confirmed outcome (legitimate retry)', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const click = { x: 10, y: 20, _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-A' } } }
    watcher([typeUse('u1', click), effectResult('u1', 'applied')], 'conv-1')
    watcher([typeUse('u2', click)], 'conv-1')

    expect(metrics.snapshot().unsafeDuplicateCount).toBe(0)
  })

  it('never counts screen reads or Clipboard-get repeats', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const screenshotTool = `mcp__${WINDOWS_SERVER_NAME}__Screenshot`
    watcher([typeUse('u1', {}, screenshotTool), typeUse('u2', {}, screenshotTool)], 'conv-1')
    const clipboardTool = `mcp__${WINDOWS_SERVER_NAME}__Clipboard`
    const clipboardGet = { mode: 'get' }
    watcher(
      [typeUse('u3', clipboardGet, clipboardTool), typeUse('u4', clipboardGet, clipboardTool)],
      'conv-1',
    )

    expect(metrics.snapshot().unsafeDuplicateCount).toBe(0)
  })

  it('counts Clipboard-set (the destructive half) duplicates', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    const clipboardTool = `mcp__${WINDOWS_SERVER_NAME}__Clipboard`
    const clipboardSet = { mode: 'set', text: 'payload' }
    watcher([typeUse('u1', clipboardSet, clipboardTool)], 'conv-1')
    watcher([typeUse('u2', clipboardSet, clipboardTool)], 'conv-1')

    expect(metrics.snapshot().unsafeDuplicateCount).toBe(1)
  })

  it('does not count a different target or different args', () => {
    const metrics = new DesktopDispatchMetrics()
    const watcher = createWrongWindowDispatchWatcher(metrics)

    watcher(
      [
        typeUse('u1', {
          x: 10,
          y: 20,
          _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-A' } },
        }),
        typeUse('u2', {
          x: 10,
          y: 20,
          _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-B' } },
        }),
        typeUse('u3', {
          x: 99,
          y: 20,
          _target: { window: { hwnd: 42, pid: 4242, digest: 'digest-A' } },
        }),
      ],
      'conv-1',
    )

    expect(metrics.snapshot().unsafeDuplicateCount).toBe(0)
  })
})
