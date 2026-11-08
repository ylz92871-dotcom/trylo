import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { workflowLearningSettings } from './settings/workflow-learning'
import { settingsForCodeRun } from './runtime/conversation-run-supervisor'
import { buildTryloV1Args } from './host-adapter/trylo-v1-runner'
import { parseCliV1Event } from './host-adapter/trylo-v1-protocol'
import { TryloV1EventAdapter } from './host-adapter/trylo-v1-event-adapter'
import { applyEvents } from './components/chat/events'
import { WorkflowReceipt } from './components/chat/WorkflowReceipt'
import { isWorkflowState, type WorkflowState } from './domain/workflow-state'
import type { FilePath } from './host-adapter/types'
import { normalizeWorkspaceHistory } from './host-adapter/conversation-history'

const workflow: WorkflowState = {
  type: 'workflow_state',
  version: 1,
  workflowVersionId: 'wfl_evidence',
  traceId: 'trace-a',
  sessionId: 'session-a',
  state: 'running',
  outcome: 'unknown',
  steps: [
    {
      nodeId: 'normalize',
      status: 'passed',
      input: 'source.csv',
      output: 'normalized.json',
      evidenceRefs: ['session:session-a/turn:t/tool:check-a'],
    },
  ],
}

describe('daily workflow learning Desktop contract', () => {
  it('preserves collection choices and bounds the independent allowance', () => {
    expect(workflowLearningSettings(undefined)).toEqual({ enabled: false, tokenBudget: 16000 })
    expect(workflowLearningSettings({ enabled: true, tokenBudget: -1 })).toEqual({
      enabled: true,
      tokenBudget: 16000,
    })
    const settings = { workflowLearning: { enabled: true, tokenBudget: 8000 } }
    const enabled = settingsForCodeRun(settings, 'D:/work' as FilePath)
    expect(enabled.learning).toBeUndefined()
    expect(enabled.workflowLearning).toEqual(settings.workflowLearning)
    expect(
      settingsForCodeRun(settings, 'D:/work' as FilePath, {
        collectNewLearning: false,
        retention: 'normal',
      }).workflowLearning,
    ).toBeUndefined()
    expect(
      settingsForCodeRun(settings, 'D:/work' as FilePath, {
        collectNewLearning: true,
        retention: 'session_only',
      }).workflowLearning,
    ).toBeUndefined()
    const built = buildTryloV1Args({
      cliPath: 'fixture.js',
      cwd: 'D:/work' as FilePath,
      workflowLearning: enabled.workflowLearning,
    })
    expect(built.args).toContain('--workflow-learning')
    expect(built.args[built.args.indexOf('--workflow-learning-budget') + 1]).toBe('8000')
    expect(built.args).not.toContain('--learning=all')
  })

  it('validates version, evidence and completion instead of trusting lifecycle completion', () => {
    expect(parseCliV1Event(JSON.stringify(workflow)).ok).toBe(true)
    expect(isWorkflowState({ ...workflow, version: 2 })).toBe(false)
    expect(
      isWorkflowState({ ...workflow, state: 'completed', outcome: 'success', steps: [] }),
    ).toBe(false)
    expect(isWorkflowState({ ...workflow, cost: { tokens: -1, wallMs: 0 } })).toBe(false)
    render(<WorkflowReceipt workflow={{ ...workflow, state: 'completed' }} />)
    expect(screen.getByText('执行结束，流程检查未完成')).toBeTruthy()
    expect(screen.getByText('normalized.json')).toBeTruthy()
  })

  it('projects updates into one persistent receipt and rejects regressive replay', () => {
    const adapter = new TryloV1EventAdapter()
    const first = adapter.feed(JSON.stringify(workflow))
    const messages = applyEvents([], first)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe('notice')
    const replayed = applyEvents(messages, adapter.feed(JSON.stringify(workflow)))
    expect(replayed).toEqual(messages)
    const old = { ...workflow, steps: [] }
    expect(applyEvents(messages, adapter.feed(JSON.stringify(old)))).toEqual(messages)
  })
})

describe('workflow receipt replay and display boundaries', () => {
  const project = (states: readonly object[]) => {
    const adapter = new TryloV1EventAdapter()
    return states.reduce<ReturnType<typeof applyEvents>>(
      (messages, state) =>
        applyEvents(
          messages,
          adapter.feed(JSON.stringify(state)).map((event) => ({ ...event, ts: 1 })),
        ),
      [] as ReturnType<typeof applyEvents>,
    )
  }

  it('keeps same trace labels in different sessions and versions separate', () => {
    expect(project([workflow, { ...workflow, sessionId: 'session-b' }])).toHaveLength(2)
    expect(project([workflow, { ...workflow, workflowVersionId: 'wfl_other' }])).toHaveLength(2)
  })

  it('updates one adopted execution across resumed trace ids', () => {
    const first = { ...workflow, executionId: 'adoption-a' }
    const resumed = {
      ...first,
      traceId: 'trace-resumed',
      state: 'waiting',
      steps: [
        ...workflow.steps,
        {
          nodeId: 'build',
          status: 'failed',
          input: 'normalized.json',
          output: 'report.json',
          evidenceRefs: ['actual:build'],
        },
      ],
    }
    const messages = project([first, resumed])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind === 'notice' && messages[0].workflow?.traceId).toBe('trace-resumed')
  })

  it('keeps a terminal receipt when the same run redelivers an earlier empty snapshot', () => {
    const terminal = { ...workflow, executionId: 'adoption-a', state: 'cancelled', steps: [] }
    const stale = { ...terminal, state: 'running' }
    expect(project([terminal, stale])).toEqual(project([terminal]))
    const resumed = { ...stale, traceId: 'new-resumed-trace' }
    const resumedReceipt = project([terminal, resumed])[0]
    expect(resumedReceipt?.kind === 'notice' && resumedReceipt.workflow?.state).toBe('running')
  })

  it('rejects rewritten facts, branch changes and older trace redelivery', () => {
    const first = { ...workflow, executionId: 'adoption-a', branchId: 'csv' }
    const resumed = { ...first, traceId: 'trace-resumed', state: 'waiting' }
    expect(project([first, resumed, first])).toEqual(project([first, resumed]))
    expect(project([first, { ...first, branchId: 'json' }])).toEqual(project([first]))
    expect(
      project([first, { ...first, steps: [{ ...workflow.steps[0], output: 'rewritten.json' }] }]),
    ).toEqual(project([first]))
  })

  it('does not downgrade verified completion on an old running snapshot', () => {
    const passed = { ...workflow, state: 'completed', outcome: 'success' }
    expect(project([passed, workflow])).toEqual(project([passed]))
  })

  it('accepts the same artifact map after native JSON persistence reorders its keys', () => {
    const first = {
      ...workflow,
      steps: [
        ...workflow.steps,
        {
          nodeId: 'consume',
          status: 'passed',
          input: 'inputs',
          output: 'joined.json',
          evidenceRefs: ['actual:join'],
          dependsOn: ['z', 'a'],
          inputBindings: { z: 'z.json', a: 'a.json' },
        },
      ],
    }
    const restored = {
      ...first,
      state: 'waiting',
      steps: [first.steps[0], { ...first.steps[1], inputBindings: { a: 'a.json', z: 'z.json' } }],
    }
    const messages = project([first, restored])
    expect(messages[0]?.kind === 'notice' && messages[0].workflow?.state).toBe('waiting')
  })

  it('round-trips the receipt and degrades unsupported persisted proof to unknown', () => {
    const messages = project([workflow])
    const raw = {
      version: 2,
      activeByKind: { code: 'chat', work: null },
      conversations: {
        chat: {
          session: {
            id: 'chat',
            kind: 'code',
            mode: 'agent',
            createdAt: 1,
            updatedAt: 1,
            turnCount: 1,
          },
          messages,
          draft: '',
        },
      },
    }
    const restored = normalizeWorkspaceHistory(JSON.parse(JSON.stringify(raw)))
    expect(
      restored.conversations.chat?.messages[0]?.kind === 'notice' &&
        restored.conversations.chat.messages[0].workflow,
    ).toEqual(workflow)
    const corrupted = JSON.parse(JSON.stringify(raw))
    corrupted.conversations.chat.messages[0].workflow.version = 99
    corrupted.conversations.chat.messages[0].text = '流程检查已通过'
    const invalid = normalizeWorkspaceHistory(corrupted).conversations.chat?.messages[0]
    expect(invalid?.kind === 'notice' && invalid.workflow).toBeUndefined()
    expect(invalid?.kind === 'notice' && invalid.text).toContain('未知')
  })

  it('validates optional budget and artifact proof instead of dropping malformed values', () => {
    expect(isWorkflowState({ ...workflow, cost: { tokens: 0.5, wallMs: 1 } })).toBe(false)
    expect(
      isWorkflowState({
        ...workflow,
        budgetReceipt: {
          initialTokens: 100,
          grantedTokens: 0,
          observedOutputTokens: 90,
          reservedUnknownTokens: 20,
          remainingTokens: 50,
          usageUncertain: true,
        },
      }),
    ).toBe(false)
    expect(
      isWorkflowState({
        ...workflow,
        steps: [{ ...workflow.steps[0], outputDigest: 'not-a-digest' }],
      }),
    ).toBe(false)
  })

  it('renders cancellation separately from the checkpoint verdict', () => {
    render(<WorkflowReceipt workflow={{ ...workflow, state: 'cancelled', outcome: 'failure' }} />)
    expect(screen.getByText('流程已取消')).toBeTruthy()
    expect(screen.getByText(/检查结果.*未通过/)).toBeTruthy()
  })

  it('shows uncertain reservations and bounded history without claiming that missing usage is zero', () => {
    const expanded = Object.assign(
      {
        ...workflow,
        state: 'budget_exhausted' as const,
        steps: Array.from({ length: 24 }, (_, index) => ({
          ...workflow.steps[0]!,
          nodeId: `node-${index}`,
        })),
      },
      {
        executionId: 'adoption-a',
        budgetReceipt: {
          initialTokens: 100,
          grantedTokens: 50,
          observedOutputTokens: 100,
          reservedUnknownTokens: 30,
          remainingTokens: 20,
          usageUncertain: true,
        },
      },
    )
    render(<WorkflowReceipt workflow={expanded} />)
    expect(screen.getByText('待核实占用')).toBeTruthy()
    expect(screen.getByText('剩余输出额度')).toBeTruthy()
    expect(screen.getAllByRole('listitem', { hidden: true }).length).toBeLessThan(24)
    fireEvent.click(screen.getByRole('button', { name: /显示更早/, hidden: true }))
    expect(screen.getAllByRole('listitem', { hidden: true }).length).toBeGreaterThan(6)
    expect(screen.queryByText(/0 token/)).toBeNull()
  })
})

it('forwards an explicit collection prohibition on a resumed workflow even when automatic learning is omitted', () => {
  const settings = { workflowLearning: { enabled: true, tokenBudget: 8000 } }
  const denied = settingsForCodeRun(settings, 'D:/work' as FilePath, {
    collectNewLearning: false,
    retention: 'normal',
  })
  const sessionOnly = settingsForCodeRun(settings, 'D:/work' as FilePath, {
    collectNewLearning: true,
    retention: 'session_only',
  })
  expect(denied.workflowLearning).toBeUndefined()
  expect(denied.workflowCollection).toBe('disabled')
  expect(sessionOnly.workflowCollection).toBe('disabled')
  const built = buildTryloV1Args({ ...denied, cwd: 'D:/work' as FilePath })
  expect(built.args).toContain('--workflow-collection')
  expect(built.args[built.args.indexOf('--workflow-collection') + 1]).toBe('disabled')
  expect(built.args).not.toContain('--workflow-learning')
  expect(
    settingsForCodeRun({ ...settings }, 'D:/work' as FilePath, {
      collectNewLearning: false,
      retention: 'normal',
    }).workflowCollection,
  ).toBeUndefined()
})
