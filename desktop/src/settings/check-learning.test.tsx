import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings, settingsDefaults } from './settings-store'
import { SettingsModal } from '../components/app-shell/SettingsModal'
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor'
import { buildTryloV1Args, permissionFlagsForV1 } from '../host-adapter/trylo-v1-runner'
import { TryloV1EventAdapter } from '../host-adapter/trylo-v1-event-adapter'
import { applyEvents } from '../components/chat/events'
import type { FilePath } from '../host-adapter/types'

vi.mock('../components/app-shell/AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('../components/app-shell/WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('../components/app-shell/SkillsModal', () => ({ SkillsModal: () => null }))
afterEach(() => {
  cleanup()
  localStorage.clear()
})

const cwd = 'D:/check-contract' as FilePath
const configured = () => ({
  ...settingsDefaults,
  cliPath: 'D:/trylo/main.js',
  checkLearning: { enabled: true, tokenBudget: 32768 },
})

it('keeps old installations off and persists a bounded independent allowance including zero', () => {
  localStorage.setItem('trylo:settings:v1', '{}')
  expect(loadSettings().checkLearning).toEqual({ enabled: false, tokenBudget: 32768 })
  for (const value of [-1, 1.5, 262145, '32768', null]) {
    localStorage.setItem(
      'trylo:settings:v1',
      JSON.stringify({ checkLearning: { enabled: true, tokenBudget: value } }),
    )
    expect(loadSettings().checkLearning).toEqual({ enabled: true, tokenBudget: 32768 })
  }
  saveSettings({ ...configured(), checkLearning: { enabled: true, tokenBudget: 0 } })
  expect(loadSettings().checkLearning).toEqual({ enabled: true, tokenBudget: 0 })
})

it('forwards check learning independently of user learning and tool permissions', () => {
  for (const userEnabled of [false, true]) {
    const run = settingsForCodeRun(
      { ...configured(), userLearning: { ...settingsDefaults.userLearning, enabled: userEnabled } },
      cwd,
    )
    expect(run.checkLearning).toEqual({ enabled: true, tokenBudget: 32768 })
    expect(run.learning).toBe(userEnabled ? 'user' : undefined)
    const args = buildTryloV1Args({ ...run, permissionLevel: 'read_only' }).args
    expect(args).toContain('--check-learning')
    expect(
      args.slice(
        args.indexOf('--check-learning-budget'),
        args.indexOf('--check-learning-budget') + 2,
      ),
    ).toEqual(['--check-learning-budget', '32768'])
    expect(args.filter((arg) => arg.startsWith('--learning='))).toEqual(
      userEnabled ? ['--learning=user'] : [],
    )
    expect(args).not.toContain('--allow-writes')
    for (const flag of permissionFlagsForV1('read_only')) expect(args).toContain(flag)
    expect(args.some((arg) => /--(?:workflow|routing|collaboration)-learning/.test(arg))).toBe(
      false,
    )
  }
})

it('snapshots settings and disables check learning for private, session-only and legacy runs', () => {
  const settings = configured()
  const run = settingsForCodeRun(settings, cwd)
  settings.checkLearning.tokenBudget = 1
  expect(run.checkLearning?.tokenBudget).toBe(32768)
  for (const directive of [
    { collectNewLearning: false, retention: 'normal' as const },
    { collectNewLearning: true, retention: 'session_only' as const },
    { collectNewLearning: true, retention: 'normal' as const, applyExistingPreferences: false },
  ]) {
    expect(settingsForCodeRun(settings, cwd, directive).checkLearning).toBeUndefined()
  }
  expect(
    buildTryloV1Args({
      cliPath: 'D:/trylo/main.js' as FilePath,
      cwd,
      checkLearning: { enabled: false, tokenBudget: 32768 },
    }).args,
  ).not.toContain('--check-learning')
})

it('rejects an invalid runner allowance before spawning instead of altering it', () => {
  expect(() =>
    buildTryloV1Args({
      cliPath: 'D:/trylo/main.js' as FilePath,
      cwd,
      checkLearning: { enabled: true, tokenBudget: 262145 },
    }),
  ).toThrow('0–262144')
})

it('saves and reopens its own switch without changing the user-learning setting', () => {
  const initial = {
    ...settingsDefaults,
    userLearning: { ...settingsDefaults.userLearning, enabled: false },
  }
  const { unmount } = render(
    <SettingsModal open initialTab="learning" initial={initial} onClose={vi.fn()} />,
  )
  const toggle = screen.getByRole('checkbox', { name: '启用检查学习' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  fireEvent.change(screen.getByLabelText('每轮检查学习额度（tokens）'), { target: { value: '0' } })
  expect(
    screen.getByText('额度为 0：记录检查经历并使用已有检查，暂不生成新检查。'),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(loadSettings().checkLearning).toEqual({ enabled: true, tokenBudget: 0 })
  expect(loadSettings().userLearning).toEqual(initial.userLearning)
  unmount()
  render(<SettingsModal open initialTab="learning" initial={loadSettings()} onClose={vi.fn()} />)
  expect(screen.getByRole('checkbox', { name: '启用检查学习' })).toBeChecked()
  expect(screen.getByLabelText('每轮检查学习额度（tokens）')).toHaveValue(0)
})

it('shows invalid draft allowance and blocks saving it', () => {
  const onSave = vi.fn()
  render(
    <SettingsModal
      open
      initialTab="learning"
      initial={configured()}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  fireEvent.change(screen.getByLabelText('每轮检查学习额度（tokens）'), {
    target: { value: '262145' },
  })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('请输入 0–262144 的整数 token 额度。')
})

it('projects a CLI check-result warning into the visible notice model without fabricating task rejection', () => {
  const adapter = new TryloV1EventAdapter()
  const warning = {
    type: 'warning',
    seq: 1,
    timestamp: '2026-11-03T00:00:00.000Z',
    sessionId: 'check-session',
    turnId: 'check-turn',
    code: 'check_learning_result',
    message: JSON.stringify({
      phase: 'before_completion',
      runs: [{ runId: 'real-run', verdict: 'fail', findings: ['total mismatch'] }],
    }),
  }
  const events = adapter.feed(JSON.stringify(warning))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: 'runtime_warning',
    code: 'check_learning_result',
    message: warning.message,
  })
  expect(applyEvents([], events)).toMatchObject([
    { kind: 'notice', role: 'system', text: warning.message },
  ])
  expect(adapter.hasTerminal).toBe(false)
})
