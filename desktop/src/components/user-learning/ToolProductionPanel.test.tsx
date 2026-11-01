import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { FilePath } from '../../host-adapter/types'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import {
  productionFixture,
  productionListFixture,
} from '../../tool-learning/production-test-support'
import { ToolProductionPanel } from './ToolProductionPanel'
afterEach(cleanup)
function runtime(stale = false) {
  const detail = productionFixture()
  const recorded: string[][] = []
  const value: ToolLearningRuntime = {
    cliPath: 'D:/cli/main.js' as FilePath,
    cwd: 'D:/workspace' as FilePath,
    process: {
      async spawn(options) {
        recorded.push([...options.args])
        const command = options.args.find((item) => item.startsWith('production-'))
        const reply =
          command === 'production-list'
            ? productionListFixture(detail)
            : command === 'production-show'
              ? { ok: true, desktopView: detail }
              : stale
                ? { ok: false, code: 'production_review_stale' }
                : { ok: true }
        options.onOutput(JSON.stringify(reply))
        options.onExit?.({
          id: 'owned',
          pid: 1,
          code: stale && command === 'production-activate' ? 52 : 0,
          signal: null,
        })
        return { id: 'owned', pid: 1, label: options.label, command: options.command }
      },
      stop: async () => {},
    },
  }
  return { value, recorded, detail }
}
async function chooseTool() {
  const row = await screen.findByRole('button', { name: /prettyjson/ })
  expect(row.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(row)
}
it('loads real-contract evidence, requires a second explicit approval, and cancellation sends no mutation', async () => {
  const fx = runtime()
  render(<ToolProductionPanel runtime={fx.value} />)
  await chooseTool()
  fireEvent.click(await screen.findByRole('button', { name: '审阅并启用' }))
  expect(screen.getByRole('region', { name: '确认工具操作' })).toBeTruthy()
  expect(fx.recorded.filter((args) => args.includes('production-activate'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(fx.recorded.filter((args) => args.includes('production-activate'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '审阅并启用' }))
  fireEvent.click(screen.getByRole('button', { name: '确认启用此版本' }))
  await waitFor(() =>
    expect(fx.recorded.filter((args) => args.includes('production-activate'))).toHaveLength(1),
  )
  const action = fx.recorded.find((args) => args.includes('production-activate'))!
  expect(action).toContain(fx.detail.versionId)
  expect(action).toContain(`production-review_v1_${'e'.repeat(64)}`)
})
it('a stale review stays a refusal and prompts a fresh read without automatic retry', async () => {
  const fx = runtime(true)
  render(<ToolProductionPanel runtime={fx.value} />)
  await chooseTool()
  fireEvent.click(await screen.findByRole('button', { name: '审阅并启用' }))
  fireEvent.click(screen.getByRole('button', { name: '确认启用此版本' }))
  expect(await screen.findByText(/审阅依据已变化/)).toBeTruthy()
  expect(fx.recorded.filter((args) => args.includes('production-activate'))).toHaveLength(1)
})
it('a filter with no match removes the previous detail and does not claim a truly empty workspace', async () => {
  const fx = runtime()
  render(<ToolProductionPanel runtime={fx.value} />)
  await chooseTool()
  await screen.findByRole('button', { name: '审阅并启用' })
  fireEvent.click(screen.getByRole('button', { name: '已启用' }))
  expect(screen.getByText(/当前筛选没有匹配工具/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '审阅并启用' })).toBeNull()
  expect(screen.queryByText('还没有准备好的工具')).toBeNull()
})
it('explains the capability in the list, detail and approval before asking the user to enable it', async () => {
  const fx = runtime()
  render(<ToolProductionPanel runtime={fx.value} />)
  const row = await screen.findByRole('button', { name: /prettyjson/ })
  expect(within(row).getByText(fx.detail.description)).toBeTruthy()
  fireEvent.click(row)
  expect(await screen.findByRole('heading', { name: fx.detail.capability })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: '审阅并启用' }))
  const approval = screen.getByRole('region', { name: '确认工具操作' })
  expect(within(approval).getByText(fx.detail.description)).toBeTruthy()
  expect(within(approval).getByText(fx.detail.mastery.whenToUse[0]!)).toBeTruthy()
  expect(within(approval).getByText(fx.detail.mastery.pitfalls[0]!)).toBeTruthy()
  expect(fx.recorded.filter((args) => args.includes('production-activate'))).toHaveLength(0)
})
