import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { WorkToolsSettings } from './WorkToolsSettings'
import { SettingsModal } from './SettingsModal'
import catalog from '../../tooling/tool-catalog.generated.json'
import { settingsDefaults } from '../../settings/settings-store'
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state'
import type { ToolPackageHealth } from '../../services-host/methods'

function mockPlatform(platformValue: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform')
  Object.defineProperty(window.navigator, 'platform', { value: platformValue, configurable: true })
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original)
    else delete (window.navigator as { platform?: string }).platform
  }
}

let restorePlatform: (() => void) | undefined

afterEach(() => {
  cleanup()
  restorePlatform?.()
  restorePlatform = undefined
})
const selected = { computer: true, browserDebug: false, cad: false }
function platform(overrides: Partial<ToolPlatformState> = {}): ToolPlatformState {
  const packages: ToolPackageHealth[] = catalog.packages.map((item) => ({
    ...item,
    builtIn: ['officecli', 'playwright', 'chrome-devtools', 'windows-mcp'].includes(item.id),
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

it('puts browser selection above the tool rows and switches it directly', () => {
  render(<SettingsModal open initial={{ ...settingsDefaults, workBrowserDebug: true, workComputer: false }} initialTab="tools" onClose={vi.fn()} />)
  const playwright = screen.getByRole('radio', { name: 'Playwright（网页浏览与操作）' })
  const devtools = screen.getByRole('radio', { name: 'Chrome DevTools（网页调试与分析）' })
  expect(devtools).toBeChecked()
  fireEvent.click(playwright)
  expect(playwright).toBeChecked()
  expect(devtools).not.toBeChecked()
  expect(within(screen.getByRole('article', { name: 'Playwright MCP' })).getByText('当前浏览器')).toBeVisible()
  expect(within(screen.getByRole('article', { name: 'OfficeCLI' })).getByText('默认启用')).toBeVisible()
  expect(within(screen.getByRole('article', { name: 'Windows-MCP' })).getByText('默认启用')).toBeVisible()
  expect(screen.queryByRole('checkbox', { name: /启用电脑控制/ })).toBeNull()
  expect(playwright.compareDocumentPosition(screen.getByRole('article', { name: 'OfficeCLI' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('offers a service reload for an old host instead of installing core tools', () => {
  const reloadService = vi.fn(async () => {})
  render(<WorkToolsSettings platform={platform({ needsServiceReload: true, reloadService })} selection={selected} />)
  const row = within(screen.getByRole('article', { name: 'OfficeCLI' }))
  expect(row.getByRole('status')).toHaveTextContent('工具服务需重载')
  expect(row.queryByRole('button')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重载工具服务' }))
  expect(reloadService).toHaveBeenCalledOnce()
})

it('takes the user from the catalogue to the existing capability controls in one action', () => {
  render(<SettingsModal open initial={settingsDefaults} initialTab="tools" onClose={vi.fn()} />)
  const details = screen.getByText('能力选择').closest('details')!
  details.open = false
  details.scrollIntoView = vi.fn()
  fireEvent.click(screen.getByRole('button', { name: '选择任务能力' }))
  expect(details.open).toBe(true)
  expect(screen.getByRole('checkbox', { name: /在 Work 中启用 CAD/ })).toHaveFocus()
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
  const browser = within(screen.getByRole('article', { name: 'Chrome DevTools MCP' }))
  expect(browser.getByText('当前浏览器')).toBeVisible()
  expect(browser.getByRole('status')).toHaveTextContent('内置 · 不可用')
  expect(within(screen.getByRole('article', { name: 'AutoCAD 自动化' })).getByText('扩展已启用')).toBeVisible()
  expect(
    within(screen.getByRole('article', { name: 'Playwright MCP' })).getByText('备用浏览器'),
  ).toBeVisible()
  expect(
    within(screen.getByRole('article', { name: 'Windows-MCP' })).getByText('默认启用'),
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

it('shows built-in tools without install or uninstall actions, including failed health', () => {
  const state = platform()
  const packages = state.packages.map(pkg => ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools'].includes(pkg.id)
    ? { ...pkg, builtIn: true, reportedVersion: pkg.id === 'officecli' ? '1.0.148' : null, available: pkg.id === 'officecli', state: pkg.id === 'officecli' ? 'installed' as const : 'not-installed' as const }
    : pkg)
  const view = render(<WorkToolsSettings platform={platform({ packages })} />)
  for (const name of ['OfficeCLI', 'Playwright MCP', 'Windows-MCP', 'Chrome DevTools MCP']) {
    const row = within(screen.getByRole('article', { name }))
    expect(row.getByRole('status')).toHaveTextContent(name === 'OfficeCLI' ? '内置 · 可用' : '内置 · 不可用')
    expect(row.queryByRole('button')).toBeNull()
    if (name === 'OfficeCLI') expect(row.getByText(/检测版本/)).toHaveTextContent('1.0.148')
  }
  view.rerender(<WorkToolsSettings platform={platform({ serviceHealth: 'down', packages })} />)
  expect(within(screen.getByRole('article', { name: 'OfficeCLI' })).getByRole('status')).toHaveTextContent('未检测')
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

describe('macOS SettingsModal and WorkToolsSettings adaptation', () => {
  it('shows only macOS-supported tools and allows Chrome DevTools without false Windows-only copy', () => {
    restorePlatform = mockPlatform('MacIntel')
    render(
      <SettingsModal
        open
        initial={{ ...settingsDefaults, workBrowserDebug: true, workCad: true }}
        initialTab="tools"
        toolPlatform={platform()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('article', { name: 'OfficeCLI' })).toBeVisible()
    expect(screen.getByRole('article', { name: 'Playwright MCP' })).toBeVisible()
    expect(screen.getByRole('article', { name: 'Chrome DevTools MCP' })).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Windows-MCP' })).toBeNull()
    expect(screen.queryByRole('article', { name: 'AutoCAD 自动化' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: '启用 Code 与 Work 的原生电脑控制' })).not.toBeChecked()
    expect(screen.queryByText(/浏览器调试是 Windows-only 能力/)).toBeNull()
    expect(screen.getByText(/Playwright 与 Chrome DevTools 均支持 macOS/)).toBeVisible()
    expect(screen.getByRole('checkbox', { name: /在 Work 中启用 CAD\/EDA/ })).toBeDisabled()
  })

  it('disables the Windows-only companion switch on macOS behavior tab', () => {
    restorePlatform = mockPlatform('MacIntel')
    render(<SettingsModal open initial={settingsDefaults} initialTab="behavior" onClose={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: '启用桌面伙伴' })).toBeDisabled()
    expect(screen.getByText(/请在受支持的 Trylo 桌面应用中启用桌面伙伴/)).toBeVisible()
  })
})
