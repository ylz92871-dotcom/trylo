import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SkillLearningPort, SkillSummary } from '../../skill-learning/cli'
import { LearnedSkillsPanel } from './LearnedSkillsPanel'

afterEach(cleanup)
const skill: SkillSummary = {
  versionId: 'version-1',
  proposalId: 'proposal-1',
  name: '报表整理',
  version: 1,
  status: 'shadow',
  createdAt: '2026-11-03T00:00:00.000Z',
  sourceOpportunityId: 'opportunity-1',
  observationRefs: ['episode-1', 'episode-2'],
  contentHash: 'hash-1',
  taskFamily: { id: 'report', intentClass: 'normalize_report', checkKind: 'acceptance' },
  usage: { loads: 1, successes: 0, failures: 0 },
}

function port(): SkillLearningPort {
  let withdrawn = false
  return {
    list: vi.fn(async () => ({
      ok: true as const,
      workspaceId: 'workspace-1',
      skills: [{ ...skill, status: withdrawn ? 'retired' : 'shadow' }],
    })),
    show: vi.fn(async () => ({
      ok: true as const,
      skill,
      content: '先检查零金额，再检查完整顺序。',
      uses: [
        {
          runId: 'run-2',
          variantId: 'variant-1',
          outcome: 'failure',
          sourceRef: 'execution:check-2',
        },
      ],
    })),
    learn: vi.fn(async () => ({
      ok: true as const,
      status: 'waiting',
      reason: 'needs_more_evidence',
      usage: { calls: 1, usageStatus: 'missing' as const },
    })),
    withdraw: vi.fn(async () => {
      withdrawn = true
      return { ok: true as const, status: 'withdrawn' }
    }),
  }
}

it('shows version, provenance and actual use; withdrawal refreshes authoritative state', async () => {
  const p = port()
  render(<LearnedSkillsPanel port={p} />)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  fireEvent.click(await screen.findByRole('button', { name: /报表整理/ }))
  expect(await screen.findByText('先检查零金额，再检查完整顺序。')).toBeTruthy()
  expect(screen.getByText(/opportunity-1/)).toBeTruthy()
  expect(screen.getByText(/episode-1、episode-2/)).toBeTruthy()
  expect(screen.getByText(/failure · run-2/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '撤回此版本' }))
  expect(await screen.findByText(/后续任务将不再装载这个版本/)).toBeTruthy()
  expect(await screen.findByText('已撤回')).toBeTruthy()
  expect(p.withdraw).toHaveBeenCalledWith('version-1', expect.any(AbortSignal))
  expect(p.list).toHaveBeenCalledTimes(2)
})

it('sends a bounded learning allowance and preserves read errors as errors', async () => {
  const p = port()
  render(<LearnedSkillsPanel port={p} />)
  await screen.findByRole('button', { name: /报表整理/ })
  fireEvent.change(screen.getByLabelText('生成 token 额度'), { target: { value: '3200' } })
  fireEvent.click(screen.getByRole('button', { name: '学习已有经历' }))
  await waitFor(() =>
    expect(p.learn).toHaveBeenCalledWith(
      { maxTokens: 3200, maxCalls: 12 },
      expect.any(AbortSignal),
    ),
  )
  expect(await screen.findByText(/needs_more_evidence/)).toBeTruthy()
  expect(screen.getByText(/总 token 用量未知/)).toBeTruthy()
  cleanup()
  render(
    <LearnedSkillsPanel
      port={{ ...p, list: async () => ({ ok: false, reason: 'unsupported_cli' }) }}
    />,
  )
  expect((await screen.findByRole('alert')).textContent).toContain('unsupported_cli')
  expect(screen.queryByText('当前工作区还没有学习技能。')).toBeNull()
})
