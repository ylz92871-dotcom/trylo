import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AppShell } from '../../src/components/app-shell/AppShell'
import { settingsDefaults } from '../../src/settings/settings-store'
import { createToolingFacade } from '../../src/tooling/tooling-facade'
import type { ServiceManager } from '../../src/services-host/service-manager'
import '../../src/index.css'

const noop = (): void => {}
const events = new Map<string, Set<(value: unknown) => void>>()
const manager = {
  currentHealth: 'ready',
  onHealth: () => noop,
  onDown: () => noop,
  client: {
    async request(method: string, params: unknown) {
      const response = await fetch('/rpc', {
        method: 'POST',
        body: JSON.stringify({ method, params }),
      })
      if (!response.ok) throw new Error(await response.text())
      return response.json()
    },
    onEvent(topic: string, handler: (value: unknown) => void) {
      const handlers = events.get(topic) ?? new Set()
      handlers.add(handler)
      events.set(topic, handlers)
      return () => handlers.delete(handler)
    },
  },
} as unknown as ServiceManager
const facade = createToolingFacade(manager.client)
Object.assign(window, {
  softwareEvent: (topic: string, value: unknown) => {
    for (const handler of events.get(topic) ?? []) handler(value)
  },
})

function Fixture() {
  const query = new URLSearchParams(location.search)
  const root = query.get('root')!
  const [mode, setMode] = useState<'code' | 'work'>(query.get('mode') === 'work' ? 'work' : 'code')
  const [left, setLeft] = useState(false)
  const [right, setRight] = useState(false)
  const [leftWidth, setLeftWidth] = useState(210)
  const [conversation, setConversation] = useState('software-acceptance')
  return (
    <AppShell
      workspaces={[{ id: 'software-project', name: '支架结构设计', root }]}
      currentWorkspaceId="software-project"
      sessions={[]}
      activeSessionId={conversation}
      runningSessionIds={new Set()}
      leftRailCollapsed={left}
      onToggleLeftRail={() => setLeft((value) => !value)}
      leftWidth={leftWidth}
      onLeftWidthChange={setLeftWidth}
      rightWidth={280}
      onRightWidthChange={noop}
      onSwitchWorkspace={noop}
      onOpenFolder={noop}
      onCloseWorkspace={noop}
      onSelectSession={noop}
      onNewSession={noop}
      onDeleteSession={noop}
      onRenameSession={noop}
      onArchiveSession={noop}
      onUnarchiveSession={noop}
      topMode={mode}
      settings={settingsDefaults}
      fileTreeRoot={null}
      rightRailOpen={right}
      onToggleRightRail={() => setRight((value) => !value)}
      settingsOpen={false}
      onSettingsOpenChange={noop}
      onSettingsSave={noop}
      remotePairingOpen={false}
      onRemotePairingOpenChange={noop}
      serviceManager={manager}
      toolingFacade={facade}
      toolMessages={[]}
    >
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          padding: 36,
          gap: 18,
          color: 'var(--fg)',
        }}
      >
        <div style={{ color: 'var(--ink-fog)', fontSize: 12 }}>结构设计 / 软件协作</div>
        <h1 style={{ fontSize: 24, fontWeight: 500, margin: 0 }}>支架建模与尺寸调整</h1>
        <p style={{ color: 'var(--ink-fog)', fontSize: 13, lineHeight: 1.8 }}>
          软件画面与对话同时保留。这里使用正式 AppShell、工具门面和后台原生工作区。
        </p>
        <div
          style={{
            borderBlock: '1px solid var(--ink-divider)',
            paddingBlock: 20,
            fontSize: 13,
            lineHeight: 2,
          }}
        >
          <strong>执行过程</strong>
          <p>已连接后台软件实例</p>
          <p>正在检查当前窗口与建模结果…</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => setMode((value) => (value === 'code' ? 'work' : 'code'))}
          >
            切换 Code / Work
          </button>
          <button
            type="button"
            onClick={() =>
              setConversation((value) =>
                value === 'software-acceptance' ? 'another-conversation' : 'software-acceptance',
              )
            }
          >
            切换验收对话
          </button>
        </div>
        <textarea
          aria-label="任务输入"
          placeholder="继续描述你的设计要求…"
          style={{
            marginTop: 'auto',
            minHeight: 100,
            borderRadius: 12,
            border: '1px solid var(--ink-divider-strong)',
            background: 'var(--ink-deep)',
            color: 'var(--fg)',
            padding: 16,
          }}
        />
      </section>
    </AppShell>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
