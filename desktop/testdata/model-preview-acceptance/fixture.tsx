import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import type { ServiceManager } from '../../src/services-host/service-manager';
import { AgentModelPreviewWorkspace } from '../../src/components/preview/AgentModelPreviewWorkspace';
import { AppShell } from '../../src/components/app-shell/AppShell';
import { settingsDefaults } from '../../src/settings/settings-store';
import type { BrowserPreviewController } from '../../src/tooling/use-browser-preview';
import '../../src/index.css';

const noop = (): void => {};
const nothing = async (): Promise<void> => {};

const events = new Map<string, Set<(payload: unknown) => void>>();
const manager = {
  currentHealth: 'ready',
  onHealth: () => () => {},
  client: {
    request: async (method: string, params: unknown) => {
      const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    onEvent: (topic: string, callback: (payload: unknown) => void) => {
      const handlers = events.get(topic) ?? new Set(); handlers.add(callback); events.set(topic, handlers);
      return () => handlers.delete(callback);
    },
  },
} as unknown as ServiceManager;

Object.assign(window, { previewEvent: (topic: string, payload: unknown) => {
  for (const handler of events.get(topic) ?? []) handler(payload);
} });

function Fixture() {
  const query = new URLSearchParams(location.search);
  const root = query.get('root')!;
  const [conversationId, setConversation] = useState('scene-a');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(210);
  const [rightOpen, setRightOpen] = useState(false);
  const browser = useMemo<BrowserPreviewController>(() => ({
    scope:`shell-fixture:${conversationId}`, status:'running', detail:'', url:'http://127.0.0.1:5173/scene',
    nativeState:{ ok:true, scope:`shell-fixture:${conversationId}`, state:'running', detail:'', control:'agent', inFlight:0,
      activeLabel:'browser-placeholder', tabs:[{id:'placeholder',label:'browser-placeholder',title:'运行场景（壳层占位）',url:'http://127.0.0.1:5173/scene'}] },
    zoom:1, frameSeq:0, latestFrame:null, start:nothing, stop:nothing, navigate:nothing, input:nothing,
    setVisible:noop, setViewportSize:noop, setBounds:nothing, setZoom:nothing, takeControl:nothing, releaseControl:nothing,
    selectTab:nothing, createTab:nothing,
  }), [conversationId]);
  const chat = <section className="model-acceptance-chat" style={{ display:'flex', flex:1, flexDirection:'column', minWidth:240, minHeight:0, padding:24 }}>
      <h1 style={{ fontSize:18 }}>3D 构建任务</h1>
      <p>独立渲染验收 · 使用正式预览组件</p>
      <button type="button" onClick={() => setConversation(value => value === 'scene-a' ? 'scene-b' : 'scene-a')}>切换聊天</button>
      <p>当前聊天：{conversationId}</p>
      <textarea aria-label="任务输入" placeholder="继续调整模型…" style={{ marginTop:'auto', minHeight:90, resize:'none' }} />
    </section>;
  if (query.has('shell')) return <>
    <style>{`.browser-tool-sidebar__picture[data-native]::after{content:'浏览器表面占位 · 不代表原生 WebView2 验收';margin:auto;color:var(--fg-muted);font-size:12px;padding:24px}.model-acceptance-chat>button{align-self:flex-start;padding:6px 12px;border:1px solid var(--border);border-radius:6px}.model-acceptance-chat>textarea{background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:12px;padding:12px;font:14px var(--font-body)}`}</style>
    <AppShell workspaces={[{id:'model-fixture',name:'模型搭建验收',root}]} currentWorkspaceId="model-fixture"
      sessions={[]} activeSessionId={conversationId} runningSessionIds={new Set()}
      leftRailCollapsed={leftCollapsed} onToggleLeftRail={() => setLeftCollapsed(value => !value)}
      leftWidth={leftWidth} onLeftWidthChange={setLeftWidth} rightWidth={280} onRightWidthChange={noop}
      onSwitchWorkspace={noop} onOpenFolder={noop} onCloseWorkspace={noop} onSelectSession={noop}
      onNewSession={noop} onDeleteSession={noop} onRenameSession={noop} onArchiveSession={noop} onUnarchiveSession={noop}
      topMode="code" settings={settingsDefaults} fileTreeRoot={null} rightRailOpen={rightOpen} onToggleRightRail={() => setRightOpen(value => !value)}
      settingsOpen={false} onSettingsOpenChange={noop} onSettingsSave={noop} remotePairingOpen={false} onRemotePairingOpenChange={noop}
      browserPreview={browser} toolMessages={[]}
      modelPreview={(onAvailable, shown) => <AgentModelPreviewWorkspace manager={manager} projectRoot={root} conversationId={conversationId} onAvailable={onAvailable} shown={shown} />}>
      {chat}
    </AppShell>
  </>;
  return <main style={{ display:'flex', height:'100vh', width:'100%', background:'var(--bg)', color:'var(--fg)' }}>
    {chat}
    <AgentModelPreviewWorkspace manager={manager} projectRoot={root} conversationId={conversationId} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
