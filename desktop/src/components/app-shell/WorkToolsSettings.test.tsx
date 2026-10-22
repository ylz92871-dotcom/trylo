import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { WorkToolsSettings } from './WorkToolsSettings'
import { SettingsModal } from './SettingsModal'
import catalog from '../../tooling/tool-catalog.generated.json'
import { settingsDefaults } from '../../settings/settings-store'
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state'
import type { ToolPackageHealth } from '../../services-host/methods'

afterEach(cleanup)
const selected = { computer: true, browserDebug: false, cad: false }
function platform(overrides: Partial<ToolPlatformState> = {}): ToolPlatformState {
  const packages: ToolPackageHealth[] = catalog.packages.map((item) => ({
    ...item,
    adoption: 'trial',
    serverName: item.id,
    state: 'not-installed',
    available: false,
    detail: '',
    autoUpdate: false,
    protocol: 'not-checked',
    checkedAt: 1,
    reportedVersion: null,
    versionMatches: null,
  }))
  return {
    serviceHealth: 'ready',
    packages,
    byId: Object.fromEntries(packages.map((pkg) => [pkg.id, pkg])),
    actions: {},
    loading: false,
    transportError: null,
    refresh: vi.fn(async () => {}),
    install: vi.fn(async () => true),
    installBrowser: vi.fn(async () => true),
    uninstall: vi.fn(async () => true),
    ...overrides,
  }
}

it('keeps the complete supported catalogue visible without a service and does not claim availability', () => {
  render(<WorkToolsSettings selection={selected} />)
  expect(screen.getAllByRole('article')).toHaveLength(catalog.packages.length)
  expect(
    screen.getAllByRole('status').filter((node) => node.textContent === '未检测'),
  ).toHaveLength(catalog.packages.length)
  expect(screen.getByText(/工具服务未连接/)).toBeVisible()
  expect(screen.queryByRole('button', { name: /^安装 / })).toBeNull()
})

it('the real settings tools category retains the catalogue when platform props are absent', () => {
  render(<SettingsModal open initial={settingsDefaults} initialTab="tools" onClose={vi.fn()} />)
  expect(screen.getAllByRole('article')).toHaveLength(catalog.packages.length)
  expect(screen.getByRole('region', { name: '工具目录' })).toBeVisible()
})

it('takes the user from the catalogue to the existing capability controls in one action', () => {
  render(<SettingsModal open initial={settingsDefaults} initialTab="tools" onClose={vi.fn()} />)
  const details = screen.getByText('能力选择').closest('details')!
  details.open = false
  details.scrollIntoView = vi.fn()
  fireEvent.click(screen.getByRole('button', { name: '选择任务能力' }))
  expect(details.open).toBe(true)
  expect(screen.getByRole('checkbox', { name: /在 Work 中启用电脑控制/ })).toHaveFocus()
})

it('searches operation definitions and clears an empty result', () => {
  render(<WorkToolsSettings />)
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索工具' }), {
    target: { value: 'entity_create_circle' },
  })
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByRole('article', { name: 'AutoCAD 自动化' })).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'does-not-exist' } })
  expect(screen.queryAllByRole('article')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
  expect(screen.getAllByRole('article')).toHaveLength(catalog.packages.length)
})

it('keeps CAD and browser debugging selected together and distinguishes selection from installation', () => {
  render(
    <WorkToolsSettings
      platform={platform()}
      selection={{ computer: false, browserDebug: true, cad: true }}
    />,
  )
  for (const name of ['Chrome DevTools MCP', 'AutoCAD 自动化']) {
    const row = within(screen.getByRole('article', { name }))
    expect(row.getByText('配置中已选用')).toBeVisible()
    expect(row.getByRole('status')).toHaveTextContent('未安装')
  }
  expect(
    within(screen.getByRole('article', { name: 'Playwright MCP' })).getByText('配置中未选用'),
  ).toBeVisible()
  expect(
    within(screen.getByRole('article', { name: 'Windows-MCP' })).getByText('配置中未选用'),
  ).toBeVisible()
  fireEvent.change(screen.getByRole('combobox', { name: '工具分类' }), {
    target: { value: 'CAD / EDA' },
  })
  expect(screen.getAllByRole('article')).toHaveLength(6)
})

it('routes installation and health refresh through existing actions', () => {
  const state = platform()
  render(<WorkToolsSettings platform={state} />)
  fireEvent.click(screen.getByRole('button', { name: '安装 AutoCAD 自动化' }))
  expect(state.install).toHaveBeenCalledWith('autocad-mcp')
  fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
  expect(state.refresh).toHaveBeenCalledOnce()
})

it('does not offer browser installation for a missing CAD application bridge', () => {
  const state = platform()
  const packages = state.packages.map((pkg) =>
    pkg.id === 'freecad-mcp'
      ? {
          ...pkg,
          state: 'condition-missing' as const,
          condition: { ok: false, reasonCode: 'bridge_missing', detail: 'FreeCAD bridge missing' },
        }
      : pkg,
  )
  render(<WorkToolsSettings platform={platform({ packages })} />)
  const row = within(screen.getByRole('article', { name: 'FreeCAD 自动化' }))
  expect(row.queryByRole('button', { name: /安装浏览器/ })).toBeNull()
  expect(row.getByRole('status')).toHaveTextContent('不可用')
})

it('does not present stale available packages as usable after the tool service disconnects', () => {
  const state = platform()
  const packages = state.packages.map((pkg) => ({
    ...pkg,
    available: true,
    state: 'installed' as const,
  }))
  render(<WorkToolsSettings platform={platform({ serviceHealth: 'down', packages })} />)
  expect(
    screen.getAllByRole('status').filter((node) => node.textContent === '未检测'),
  ).toHaveLength(catalog.packages.length)
  expect(screen.queryByRole('button', { name: /^卸载 / })).toBeNull()
})

it('permits retrying a failed health request and preserves the catalogue while loading', () => {
  const state = platform({ transportError: '工具服务不可用', packages: [] })
  const view = render(<WorkToolsSettings platform={state} />)
  fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
  expect(state.refresh).toHaveBeenCalledOnce()
  view.rerender(<WorkToolsSettings platform={platform({ loading: true, packages: [] })} />)
  expect(screen.getAllByRole('article')).toHaveLength(catalog.packages.length)
  expect(
    screen.getAllByRole('status').filter((node) => node.textContent === '检测中…'),
  ).toHaveLength(catalog.packages.length)
})
