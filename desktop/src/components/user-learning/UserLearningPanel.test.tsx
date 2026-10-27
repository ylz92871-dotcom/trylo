import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { UserLearningPanel, type UserLearningPanelProps } from './UserLearningPanel'
import type { LearningPort } from '../../learning/learning-port'
import type { UserLearningSnapshot, UserLearningSettings } from '../../user-learning/types'
import { filterEvidence, evidenceSurface, INSPECTOR_PREFS_KEY } from './inspector-prefs'
import type { EvidenceRecord } from '../../user-learning/types'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const EMPTY_SNAPSHOT = {
  schemaVersion: 2,
  userId: 'u1',
  traces: [],
  evidence: [],
  evidenceRelations: [],
  conclusions: [],
  conclusionRelations: [],
  profileFacts: [],
  userModels: [],
  userModelDerivations: [],
  projectContexts: [],
  policyRules: [],
  policyBundles: [],
  policyDecisions: [],
  cognitionSessions: [],
  cognitionCooldowns: [],
  learningRuns: [],
  dirtyDimensions: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as UserLearningSnapshot

const SETTINGS: UserLearningSettings = {
  enabled: true,
  defaultMode: 'shadow',
  dimensionMode: {},
  cognitionEnabled: true,
}

function fakePort(over: Record<string, unknown> = {}): LearningPort {
  return {
    listPending: vi.fn(async () => ({
      ok: true,
      pending: [
        {
          id: 'p1',
          subsystem: 'skills',
          action: 'create',
          summary: 'a staged skill',
          origin: 'foreground',
          created_at: 1787994502,
        },
      ],
      count: 1,
    })),
    pendingDetail: vi.fn(async () => ({ ok: true, detail: { item: { id: 'p1' } } })),
    applyPending: vi.fn(async () => ({ ok: true })),
    discardPending: vi.fn(async () => ({ ok: true })),
    memorySnapshot: vi.fn(async () => ({ ok: true, snapshot: { memoryBlock: '', userBlock: '' } })),
    skills: vi.fn(async () => ({ ok: true, skills: [] })),
    ...over,
  } as unknown as LearningPort
}

function renderPanel(
  port: LearningPort = fakePort(),
  opts: Readonly<Partial<UserLearningPanelProps>> = {},
) {
  return render(
    <UserLearningPanel
      open
      snapshot={EMPTY_SNAPSHOT}
      settings={SETTINGS}
      learningPort={port}
      onClose={vi.fn()}
      onSettingsChange={vi.fn()}
      openedFrom="code"
      {...opts}
    />,
  )
}

// A minimal, valid EvidenceRecord factory for the virtuo list.
let seq = 0
function ev(over: Partial<EvidenceRecord> & { product: 'code' | 'work' }): EvidenceRecord {
  seq += 1
  return {
    id: `e${seq}`,
    userId: 'u1',
    source: {
      sessionId: 's',
      taskId: 't',
      turnIds: [],
      actionIds: [],
      sourceHash: `h${seq}`,
      traceId: 'tr',
    },
    origin: { channel: 'interaction', eventType: 'approval', stage: 'post_execution' },
    rawObservation: { text: `raw ${seq}` },
    inference: { claim: `claim ${seq}`, semanticConfidence: 0.8, engineeringRelevance: 0.6 },
    context: { workspaceId: 'w', projectId: 'p', scopeTags: [], product: over.product },
    strength: { contextInformedness: 'task_context', band: 'medium' },
    governance: { level: 2, userLocked: false },
    createdAt: 1000 + seq,
    ...over,
  }
}

describe('UserLearningPanel', () => {
  it('keeps all fifteen dimension settings and forwards an exact dimension override', () => {
    const onSettingsChange = vi.fn()
    renderPanel(undefined, { onSettingsChange })
    fireEvent.click(screen.getByRole('button', { name: '应用设置' }))
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(15)
    const first = within(list).getAllByRole('listitem')[0]!
    fireEvent.click(within(first).getByRole('button', { name: '应用偏好' }))
    expect(onSettingsChange).toHaveBeenCalledWith({ dimensionMode: { agent_autonomy: 'enforced' } })
    expect(screen.queryByText('a staged skill')).toBeNull()
  })

  it('retains original data and cognition callbacks and exposes all seven metrics', () => {
    const onExport = vi.fn(),
      onDeleteUserData = vi.fn(),
      onCorrect = vi.fn(),
      onOpenCognition = vi.fn()
    renderPanel(undefined, { onExport, onDeleteUserData, onCorrect, onOpenCognition })
    fireEvent.click(screen.getByRole('button', { name: '聊聊我的工作方式' }))
    expect(onOpenCognition).toHaveBeenCalledOnce()
    fireEvent.click(screen.getAllByRole('button', { name: '数据管理' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '导出数据' }))
    fireEvent.click(screen.getByRole('button', { name: '纠正理解' }))
    fireEvent.click(screen.getByRole('button', { name: '删除全部学习数据' }))
    expect(onExport).toHaveBeenCalledOnce()
    expect(onCorrect).toHaveBeenCalledOnce()
    expect(onDeleteUserData).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '协作效果' }))
    expect(screen.getAllByRole('term')).toHaveLength(7)
    expect(screen.getAllByText('样本不足').length).toBeGreaterThan(0)
  })
  it('opens from a surface into 用户认知 + that surface, not an empty agent queue', async () => {
    renderPanel(undefined, { openedFrom: 'work' })
    expect(screen.getByRole('button', { name: /用户学习/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /智能体学习/ })).toBeTruthy()
    // Default module is 用户认知 → no staged queue rendered.
    expect(screen.queryByText('a staged skill')).toBeNull()
    // Work surface default → Work 三维度 coverage shown.
    expect(await screen.findByText(/Work 三维度/)).toBeTruthy()
  })

  it('switches to User Cognition and shows the Evidence→Policy shadow tabs', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))
    expect(screen.getByRole('button', { name: '学习依据' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '应用设置' })).toBeTruthy()
  })

  it('Agent Learning has a 已批准记录 sub-tab showing committed memory/skills', async () => {
    const port = fakePort({
      memorySnapshot: vi.fn(async () => ({
        ok: true,
        snapshot: { memoryBlock: '- remembered fact', userBlock: '' },
      })),
      skills: vi.fn(async () => ({
        ok: true,
        skills: [{ name: 'demo-skill', category: 'misc', description: 'a done skill' }],
      })),
    })
    renderPanel(port, { openedFrom: undefined })
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    fireEvent.click(screen.getByRole('button', { name: '已批准记录' }))
    expect(await screen.findByText(/remembered fact/)).toBeTruthy()
    expect(screen.getByText('demo-skill')).toBeTruthy()
  })

  it('the pending queue stays mounted while switching modules, so the badge survives', async () => {
    const port = fakePort()
    renderPanel(port, { openedFrom: undefined })
    // Switch to 代理学习 to mount the staged queue.
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    await waitFor(() => expect(port.listPending).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /用户学习/ }))
    expect(screen.getByRole('button', { name: /智能体学习/ }).textContent).toContain('1')
    expect(port.listPending).toHaveBeenCalledTimes(1)
  })

  it('shows Chinese dimension labels and surfaces the surface filter chips on Evidence', async () => {
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      evidence: [
        ev({
          product: 'code',
          inference: { claim: '之后也要验证', semanticConfidence: 0.8, engineeringRelevance: 0.6 },
        }),
        ev({
          product: 'work',
          inference: { claim: '这个周报很好', semanticConfidence: 0.8, engineeringRelevance: 0.6 },
        }),
      ],
    } as unknown as UserLearningSnapshot
    renderPanel(fakePort(), { snapshot })
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))
    fireEvent.click(screen.getAllByRole('button', { name: '全部' })[0]!)
    expect(screen.getAllByRole('button', { name: '全部' }).length).toBeGreaterThan(0)
    expect(screen.getByText('验证与审核')).toBeTruthy() // dimensionLabel(verification_audit) via inferDimension
  })

  it('filterEvidence applies surface + strength filters and dates desc', () => {
    const a = ev({
      product: 'code',
      createdAt: 1000,
      strength: { contextInformedness: 'task_context', band: 'weak' },
    })
    const b = ev({
      product: 'work',
      createdAt: 3000,
      strength: { contextInformedness: 'task_context', band: 'strong' },
    })
    const c = ev({
      product: 'work',
      createdAt: 2000,
      strength: { contextInformedness: 'task_context', band: 'strong' },
    })
    const r = filterEvidence([a, b, c], {
      surfaceFilter: 'work',
      channelFilter: 'all',
      dimensionFilter: 'all',
      strengthFilter: 'all',
    })
    expect(r.map((x) => x.id)).toEqual([b.id, c.id])
    expect(r.map((x) => evidenceSurface(x))).toEqual(['work', 'work'])
  })

  it('explains a persisted empty strength filter and restores evidence with 全部强度', () => {
    localStorage.setItem(INSPECTOR_PREFS_KEY, JSON.stringify({ strengthFilter: 'authoritative' }))
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      evidence: [ev({ product: 'code' }), ev({ product: 'work' })],
    }
    renderPanel(undefined, { snapshot })
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))

    expect(screen.getByRole('status').textContent).toBe('匹配 0 / 2 条依据')
    expect(screen.getByText(/没有符合当前筛选条件的学习依据/)).toBeTruthy()
    expect(screen.queryByText(/还没有 Evidence/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全部强度', pressed: false }))
    expect(screen.getByRole('status').textContent).toBe('匹配 2 / 2 条依据')
    expect(screen.getByText(snapshot.evidence[0]!.inference.claim)).toBeTruthy()
    expect(screen.getByText(snapshot.evidence[1]!.inference.claim)).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(INSPECTOR_PREFS_KEY)!).strengthFilter).toBe('all')
  })

  it('clears search and every evidence filter together without replacing the snapshot', () => {
    localStorage.setItem(
      INSPECTOR_PREFS_KEY,
      JSON.stringify({
        surfaceFilter: 'work',
        channelFilter: 'cognition',
        dimensionFilter: 'verification_audit',
        strengthFilter: 'authoritative',
      }),
    )
    const snapshot = { ...EMPTY_SNAPSHOT, evidence: [ev({ product: 'code' })] }
    renderPanel(undefined, { snapshot })
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索学习依据' }), {
      target: { value: '找不到的内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))

    expect((screen.getByRole('textbox', { name: '搜索学习依据' }) as HTMLInputElement).value).toBe(
      '',
    )
    expect(screen.getByRole('status').textContent).toBe('匹配 1 / 1 条依据')
    expect(screen.getByText(snapshot.evidence[0]!.inference.claim)).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(INSPECTOR_PREFS_KEY)!)).toMatchObject({
      surfaceFilter: 'all',
      channelFilter: 'all',
      dimensionFilter: 'all',
      strengthFilter: 'all',
      cognitionTab: 'evidence',
    })
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull()
  })

  it('distinguishes an empty store from a filtered list and reports matches before the 100-row cap', () => {
    const view = renderPanel(undefined, { openedFrom: undefined })
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))
    expect(screen.getByText(/还没有 Evidence/)).toBeTruthy()
    expect(screen.queryByText(/没有符合当前筛选条件/)).toBeNull()
    view.unmount()

    renderPanel(undefined, {
      openedFrom: undefined,
      snapshot: {
        ...EMPTY_SNAPSHOT,
        evidence: Array.from({ length: 102 }, () => ev({ product: 'code' })),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '学习依据' }))
    expect(screen.getByRole('status').textContent).toBe('匹配 102 / 102 条依据，显示最新 100 条')
  })
})
