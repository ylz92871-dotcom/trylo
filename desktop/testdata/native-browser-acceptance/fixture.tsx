// Test-only shell. A headless Chromium cannot display the WebView2 native surface.
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from '../../src/components/app-shell/AppShell'
import { InputBar } from '../../src/components/chat/InputBar'
import { settingsDefaults } from '../../src/settings/settings-store'
import type { ChatMessage } from '../../src/components/chat/types'
import type { BrowserPreviewController } from '../../src/tooling/use-browser-preview'
import type { NativeBrowserBounds } from '../../src/host-adapter/native-browser'
import '../../src/index.css'

const noop = (): void => {}
const nothing = async (): Promise<void> => {}
const query = new URLSearchParams(location.search);
const phase = query.get('phase') ?? 'executing';
const navigationError = query.has('navigationError') ? { url: 'https://qoder/', code: 'ERR_NAME_NOT_RESOLVED' } : undefined;
const user: ChatMessage = { id: 'fixture-turn', kind: 'text', role: 'user', createdAt: 1, text: '检查页面上的查询表单' }
const tool: ChatMessage = { id: 'fixture-tool', turnId: user.id, kind: 'tool', role: 'assistant', createdAt: Date.now() - 2000,
  tool: 'mcp__trylo-playwright__browser_click', input: { element: '查询' }, summary: '点击查询',
  status: phase === 'executing' || phase === 'connecting' ? 'running' : phase === 'failed' ? 'error' : 'done',
  durationMs: phase === 'executing' || phase === 'connecting' ? undefined : 1230,
  completedAt: phase === 'executing' || phase === 'connecting' ? undefined : 1232,
  outputError: phase === 'failed' ? '未找到“查询”按钮，页面可能已更新。' : undefined }
const messages: readonly ChatMessage[] = phase === 'idle' ? [user] : phase === 'stopped' ? [user, tool,
  { id: 'run-cancelled:fixture', turnId: user.id, kind: 'notice', role: 'system', createdAt: 1233, text: '任务已停止。' }] : [user, tool]

function Fixture() {
  const [text, setText] = useState('');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(210);
  const [control, setControl] = useState<'agent' | 'user' | 'pending'>('agent')
  const [zoom, setZoom] = useState(1)
  const preview = useMemo<BrowserPreviewController>(() => ({ scope: 'headless-fixture',
    status: phase === 'connecting' ? 'starting' : phase === 'disconnected' ? 'error' : 'running',
    detail: phase === 'disconnected' ? '浏览器服务连接已断开。' : '', url: 'https://fixture.test/search',
    nativeState: phase === 'connecting' || phase === 'disconnected' ? undefined : {
      ok: true, scope: 'headless-fixture', state: 'running', detail: '', activeLabel: 'fixture-tab', control, inFlight: 0,
      tabs: [{ id: 'fixture-page', label: 'fixture-tab', title: '查询页面', url: 'https://fixture.test/search', navigationError }] },
    zoom, frameSeq: 0, latestFrame: null, start: nothing, stop: nothing, navigate: nothing, input: nothing,
    setVisible: noop, setViewportSize: noop, setBounds: async (bounds: NativeBrowserBounds, visible: boolean) => {
      const measured = document.querySelector('.browser-tool-sidebar__picture')?.getBoundingClientRect();
      const sample = { ...bounds, visible, at: performance.now(), dom: measured && { x: measured.x, y: measured.y, width: measured.width, height: measured.height } };
      const trace = (window as Window & { __resizeTrace?: unknown[] }).__resizeTrace ??= [];
      trace.push(sample);
      Object.assign(window, { __nativeBounds: sample });
    }, setZoom: async value => setZoom(value), takeControl: async () => setControl('user'),
    releaseControl: async () => setControl('agent'), selectTab: nothing, createTab: nothing,
  }), [control, zoom])
  return <>
    <style>{`.headless-chat{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}.headless-message{flex:1;padding:28px;overflow:auto}.headless-message p{font-size:14px;line-height:1.7}.browser-tool-sidebar__picture[data-native]:not(:has(.browser-tool-sidebar__empty))::after{content:'原生视图区域 · 无头壳层预览';margin:auto;color:var(--fg-muted);font-size:12px}`}</style>
    <AppShell workspaces={[{ id: 'fixture', name: '无头验收', root: 'D:/headless-fixture' }]} currentWorkspaceId="fixture"
      sessions={[]} activeSessionId="fixture-session" runningSessionIds={new Set(phase === 'executing' || phase === 'connecting' ? ['fixture-session'] : [])}
      leftRailCollapsed={leftCollapsed} onToggleLeftRail={() => setLeftCollapsed(value => !value)} onSwitchWorkspace={noop} onOpenFolder={noop} onCloseWorkspace={noop}
      onSelectSession={noop} onNewSession={noop} onDeleteSession={noop} onRenameSession={noop} onArchiveSession={noop} onUnarchiveSession={noop}
      topMode="code" settings={settingsDefaults} fileTreeRoot={null} rightRailOpen={false} onToggleRightRail={noop}
      leftWidth={leftWidth} onLeftWidthChange={setLeftWidth} rightWidth={260} onRightWidthChange={noop} settingsOpen={false}
      onSettingsOpenChange={noop} onSettingsSave={noop} remotePairingOpen={false} onRemotePairingOpenChange={noop}
      browserPreview={preview} toolMessages={messages}>
      <div className="headless-chat"><div className="headless-message"><p>检查页面上的查询表单</p><p>浏览器侧栏七态与尺寸验收。此页只展示真实壳层组件，原生 WebView2 页面需在桌面应用中验收。</p></div>
        <InputBar codeMode="agent" onCodeModeChange={noop} onSend={noop} text={text} onTextChange={setText}
          messages={messages} running={phase === 'executing'} contextUsed={0} contextWindow={200000} model="验收模型"
          compacting={false} attachments={[]} onAddAttachment={noop} onRemoveAttachment={noop} onCompact={noop}
          activeProcessId={null} permissionLevel="workspace_write" permissionSource="settings" onPermissionLevelChange={noop} />
      </div>
    </AppShell>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
