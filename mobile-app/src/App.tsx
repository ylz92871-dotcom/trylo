import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IonApp,
  IonAvatar,
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonChip,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonPage,
  IonProgressBar,
  IonRange,
  IonRefresher,
  IonRefresherContent,
  IonRippleEffect,
  IonSpinner,
  IonTabBar,
  IonTabButton,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToolbar,
  RefresherEventDetail,
} from '@ionic/react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import {
  alertCircleOutline,
  arrowForward,
  attachOutline,
  chatbubbleEllipsesOutline,
  checkmarkOutline,
  closeOutline,
  documentTextOutline,
  imageOutline,
  checkmarkCircle,
  chevronForward,
  closeCircleOutline,
  copyOutline,
  codeSlashOutline,
  desktopOutline,
  eyeOutline,
  flash,
  folderOpenOutline,
  hardwareChipOutline,
  homeOutline,
  informationCircleOutline,
  languageOutline,
  layersOutline,
  lockClosedOutline,
  paperPlane,
  playOutline,
  radioOutline,
  qrCodeOutline,
  sparklesOutline,
  settingsOutline,
  shieldCheckmarkOutline,
  stopCircleOutline,
  terminalOutline,
  timeOutline,
  trailSignOutline,
  wifiOutline,
} from 'ionicons/icons';
import { BrandMark, EmptyState, MarkdownMessage, UiLanguage, AttachmentStrip, formatBytes, formatChatTime, formatRecentTime, hasWideMarkdownBlock, uiText } from './ui';
import DirectChatView from './DirectChatView';
import { buildAttachment, type DirectAttachment, MAX_ATTACHMENTS_PER_MESSAGE } from './directChat';
import { readLatestCachedConversation, saveRemoteConversation } from './remoteCache';
import {
  GatewayConnectionState,
  RemoteArtifact,
  RemoteChatEvent,
  RemoteChatMessage,
  RemoteSurface,
  gatewayClient,
  parsePairingData,
  RemoteSnapshot,
} from './gateway';

type TabId = 'home' | 'runs' | 'chat' | 'approvals';
type AppModule = 'direct' | 'remote';

type ToastState = { message: string; color?: string } | null;

const APP_VERSION = '1.2.0';
const APP_RELEASE_DATE = '2026.09.06';

const statusLabels = {
  zh: { idle: '空闲', thinking: '思考中', running: '执行中', waiting: '等待中', done: '已完成', failed: '失败' },
  en: { idle: 'Idle', thinking: 'Thinking', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed' },
};

const modeLabels = {
  zh: { agent: 'Agent 模式', plan: 'Plan 模式', chat: 'Chat 模式', cognition: 'Cognition 模式', office: 'Office 模式' },
  en: { agent: 'Agent mode', plan: 'Plan mode', chat: 'Chat mode', cognition: 'Cognition mode', office: 'Office mode' },
};

const timelineIcons = {
  thinking: trailSignOutline,
  inspect: eyeOutline,
  change: codeSlashOutline,
  command: terminalOutline,
  approval: shieldCheckmarkOutline,
  progress: flash,
};

const tabMeta: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'home', label: '概览', icon: homeOutline },
  { id: 'runs', label: '任务', icon: layersOutline },
  { id: 'chat', label: '对话', icon: chatbubbleEllipsesOutline },
  { id: 'approvals', label: '审批', icon: shieldCheckmarkOutline },
];

const REMOTE_SURFACE_STORAGE_KEY = 'trylo.remoteSurface';

function loadRemoteSurface(): RemoteSurface {
  return localStorage.getItem(REMOTE_SURFACE_STORAGE_KEY) === 'work' ? 'work' : 'code';
}

function App() {
  const [activeModule, setActiveModule] = useState<AppModule>(() =>
    localStorage.getItem('trylo.activeModule') === 'remote' ? 'remote' : 'direct',
  );
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [actionApprovalId, setActionApprovalId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [composer, setComposer] = useState('');
  const [isDemo, setIsDemo] = useState(gatewayClient.isDemo);
  const [connectionState, setConnectionState] = useState<GatewayConnectionState>(
    gatewayClient.isDemo ? 'connected' : 'connecting',
  );
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [messages, setMessages] = useState<RemoteChatMessage[]>([]);
  const [offlineCacheAt, setOfflineCacheAt] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<RemoteArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [viewerArtifactPath, setViewerArtifactPath] = useState<string | null>(null);
  const [chatAttachments, setChatAttachments] = useState<DirectAttachment[]>([]);
  const [processingChatAttachments, setProcessingChatAttachments] = useState(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [remoteSurface, setRemoteSurface] = useState<RemoteSurface>(loadRemoteSurface);
  const [chatFontScale, setChatFontScale] = useState(() => {
    const stored = Number(localStorage.getItem('trylo.chatFontScale'));
    return Number.isFinite(stored) && stored >= 0.9 && stored <= 1.35 ? stored : 1.1;
  });
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() =>
    localStorage.getItem('trylo.uiLanguage') === 'en' ? 'en' : 'zh',
  );

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-scale', String(chatFontScale));
    localStorage.setItem('trylo.chatFontScale', String(chatFontScale));
  }, [chatFontScale]);

  useEffect(() => {
    document.documentElement.lang = uiLanguage === 'en' ? 'en' : 'zh-CN';
    localStorage.setItem('trylo.uiLanguage', uiLanguage);
  }, [uiLanguage]);

  useEffect(() => {
    localStorage.setItem('trylo.activeModule', activeModule);
  }, [activeModule]);

  useEffect(() => {
    localStorage.setItem(REMOTE_SURFACE_STORAGE_KEY, remoteSurface);
  }, [remoteSurface]);

  // ChatView surfaces transient notices (e.g. attachment limits) through a
  // lightweight event so it does not need its own toast portal.
  useEffect(() => {
    const handler = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (message) setToast({ message, color: 'warning' });
    };
    window.addEventListener('trylo-chat-toast', handler as EventListener);
    return () => window.removeEventListener('trylo-chat-toast', handler as EventListener);
  }, []);

  const handleChatEvent = (event: RemoteChatEvent) => {
    const responseId = `response-${event.requestId}`;
    if (event.type === 'chat_started') {
      setMessages(current => current.some(message => message.id === responseId)
        ? current
        : current.concat({ id: responseId, role: 'assistant', text: '', at: event.at || Date.now() }));
      return;
    }
    if (event.type === 'chat_delta') {
      setMessages(current => {
        const existing = current.find(message => message.id === responseId);
        if (!existing) {
          return current.concat({
            id: responseId,
            role: 'assistant',
            text: String(event.delta || ''),
            at: event.at || Date.now(),
          });
        }
        return current.map(message => message.id === responseId
          ? { ...message, text: message.text + String(event.delta || '') }
          : message);
      });
      return;
    }
    if (event.type === 'chat_complete') {
      setMessages(current => current.some(message => message.id === responseId)
        ? current.map(message => message.id === responseId ? { ...message, text: String(event.text || message.text) } : message)
        : current.concat({ id: responseId, role: 'assistant', text: String(event.text || ''), at: event.at || Date.now() }));
      return;
    }
    if (event.type === 'chat_error') {
      setMessages(current => current.filter(message => message.id !== responseId));
      setToast({ message: event.error || '电脑端回复失败', color: 'danger' });
    }
  };

  const loadSnapshot = async () => {
    try {
      const next = await gatewayClient.getSnapshot();
      const projectState = await gatewayClient.getProjects().catch(() => ({
        projects: next.projects || [],
        activeProjectId: next.activeProjectId || '',
      }));
      next.projects = projectState.projects;
      next.activeProjectId = projectState.activeProjectId;
      setSnapshot(next);
      setMessages(next.conversation || []);
      setOfflineCacheAt(null);
      saveRemoteConversation(next.activeSessionId || 'active', next.device.workspace, next.conversation || []);
    } catch (error) {
      setConnectionState('offline');
      // Offline展位：展示本机只读缓存（电脑仍是唯一权威，不回写）。
      const cached = readLatestCachedConversation();
      if (cached?.messages.length) {
        setMessages(cached.messages);
        setOfflineCacheAt(cached.at);
      }
      setSnapshot(current => current || {
        device: {
          id: gatewayClient.currentConfig.deviceId || 'offline-device',
          name: gatewayClient.currentConfig.deviceName || 'Trylo computer',
          workspace: '等待电脑上线',
          online: false,
          latencyMs: 0,
          lastSeenAt: Date.now(),
        },
        agent: {
          status: 'idle',
          title: '电脑暂时离线',
          detail: 'App 会在后台继续尝试连接',
          progress: 0,
          elapsed: '00:00',
          mode: 'agent',
          phase: 'ready',
          finalResponse: null,
          technicalEventCount: 0,
          timeline: [],
        },
        sessions: [],
        activeSessionId: '',
        conversation: [],
        approvals: [],
        projects: [],
        activeProjectId: '',
      });
      setToast({ message: error instanceof Error ? error.message : '无法连接 Gateway', color: 'danger' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let dispose = () => {};

    const connect = async () => {
      try {
        await gatewayClient.initialize();
        if (cancelled) return;
        setIsDemo(gatewayClient.isDemo);
        setConnectionState(gatewayClient.isDemo ? 'connected' : 'connecting');
        await loadSnapshot();
        if (cancelled) return;
        if (!gatewayClient.isDemo) {
          const history = await gatewayClient.getChatHistory();
          if (cancelled) return;
          setMessages(history);
          setOfflineCacheAt(null);
          const current = gatewayClient.currentConfig;
          saveRemoteConversation('active', current.deviceName || '', history);
        }
        dispose = await gatewayClient.subscribe(
          next => {
            setSnapshot(next);
            setMessages(next.conversation || []);
            setOfflineCacheAt(null);
            saveRemoteConversation(next.activeSessionId || 'active', next.device.workspace, next.conversation || []);
          },
          state => setConnectionState(state),
          handleChatEvent,
        );
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setConnectionState('offline');
        setToast({ message: error instanceof Error ? error.message : '安全存储初始化失败', color: 'danger' });
      }
    };

    void connect();
    return () => {
      cancelled = true;
      dispose();
    };
  }, [connectionVersion]);

  const localizedTabs = useMemo(() => tabMeta.map(item => ({
    ...item,
    label: uiLanguage === 'en'
      ? ({ home: 'Overview', runs: 'Runs', chat: 'Chat', approvals: 'Approvals' } as Record<TabId, string>)[item.id]
      : item.label,
  })), [uiLanguage]);

  const refresh = async (event: CustomEvent<RefresherEventDetail>) => {
    await loadSnapshot();
    event.detail.complete();
  };

  const loadArtifacts = async () => {
    if (gatewayClient.isDemo) {
      setArtifacts([]);
      return;
    }
    setArtifactsLoading(true);
    try {
      setArtifacts(await gatewayClient.getArtifacts());
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '无法读取产物列表', color: 'danger' });
    } finally {
      setArtifactsLoading(false);
    }
  };

  // Artifacts follow the Runs tab (and reconnects) — the list is cheap and
  // read-only; content bytes are only fetched when a row is tapped open.
  useEffect(() => {
    if (activeModule === 'remote' && activeTab === 'runs' && snapshot) {
      void loadArtifacts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, activeTab, snapshot?.activeProjectId, connectionVersion]);

  const decideApproval = async (decision: 'allow' | 'deny') => {
    if (!actionApprovalId || !snapshot) return false;
    try {
      await gatewayClient.decidePermission(actionApprovalId, decision);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '审批提交失败', color: 'danger' });
      return false;
    }
    setSnapshot({
      ...snapshot,
      approvals: snapshot.approvals.filter(item => item.id !== actionApprovalId),
    });
    setActionApprovalId(null);
    setToast({
      message: decision === 'allow' ? '已允许本次操作' : '已拒绝本次操作',
      color: decision === 'allow' ? 'success' : 'medium',
    });
    return true;
  };

  const sendMessage = async () => {
    const text = composer.trim();
    if (!text && chatAttachments.length === 0) return;
    const outgoing = chatAttachments;
    const localId = `m-${Date.now()}`;
    setMessages(current => current.concat({
      id: localId,
      role: 'user',
      text,
      at: Date.now(),
      attachments: outgoing.length ? outgoing : undefined,
    }));
    setComposer('');
    setChatAttachments([]);
    try {
      await gatewayClient.sendChat(text, outgoing, { surface: remoteSurface });
    } catch (error) {
      setMessages(current => current.filter(message => message.id !== localId));
      setChatAttachments(outgoing);
      setToast({ message: error instanceof Error ? error.message : '消息发送失败', color: 'danger' });
      return;
    }
    setToast({
      message: isDemo
        ? '演示模式：消息已加入本地会话'
        : remoteSurface === 'work' ? '已发送到电脑 Work' : '已发送到电脑 Code',
      color: 'primary',
    });
  };

  const cancelCurrentTask = async () => {
    try {
      await gatewayClient.cancelCurrentTask();
      setToast({ message: isDemo ? '演示模式：已模拟停止任务' : '停止请求已发送', color: 'medium' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '无法停止任务', color: 'danger' });
    }
  };

  const applyPairing = async (raw: string) => {
    const pairing = parsePairingData(raw);
    await gatewayClient.configureFromPairing(pairing);
    setIsDemo(false);
    setConnectionState('connecting');
    setConnectionVersion(value => value + 1);
    setPairingOpen(false);
    setToast({ message: `正在连接 ${pairing.deviceName}`, color: 'primary' });
  };

  const switchToDemo = async () => {
    await gatewayClient.useDemo();
    setIsDemo(true);
    setConnectionState('connected');
    setConnectionVersion(value => value + 1);
    setPairingOpen(false);
  };

  const openProjects = async () => {
    setProjectsOpen(true);
    try {
      const projectState = await gatewayClient.getProjects();
      setSnapshot(current => current ? { ...current, ...projectState } : current);
    } catch {
      // Keep the last known list while the gateway reconnects.
    }
  };

  const switchProject = async (projectId: string) => {
    if (!snapshot || projectId === snapshot.activeProjectId) {
      setProjectsOpen(false);
      return;
    }
    try {
      await gatewayClient.selectProject(projectId);
      setProjectsOpen(false);
      setConnectionState('connecting');
      setToast({ message: '正在电脑上切换项目，连接会自动恢复', color: 'primary' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '无法切换项目', color: 'danger' });
    }
  };

  const selectProjectSession = async (sessionId: string) => {
    try {
      const result = await gatewayClient.selectSession(sessionId);
      setActiveTab('chat');
      if (result.switching) {
        setConnectionState('connecting');
        setToast({ message: uiText(uiLanguage, '正在切换项目并恢复对话', 'Switching project and restoring chat'), color: 'primary' });
      }
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : uiText(uiLanguage, '无法恢复对话', 'Unable to restore chat'), color: 'danger' });
    }
  };

  if ((loading || !snapshot) && activeModule === 'remote') {
    return (
      <IonApp>
        <div className="launch-screen">
          <BrandMark />
          <div className="launch-screen__copy">
            <strong>Trylo Code</strong>
            <span>{uiText(uiLanguage, '正在寻找你的工作空间', 'Finding your workspace')}</span>
          </div>
          <IonSpinner name="crescent" />
        </div>
      </IonApp>
    );
  }

  const remoteSnapshot = snapshot;

  return (
    <IonApp className={`app-module--${activeModule}`}>
      <IonPage>
        <IonHeader className="app-header" translucent>
          <IonToolbar>
            <div className="toolbar-brand" slot="start">
              <BrandMark small />
              <div>
                <span>Trylo Code</span>
                <small>
                  {activeModule === 'remote' && remoteSnapshot ? (
                    <>
                      <i className={`online-dot${connectionState === 'offline' ? ' online-dot--offline' : ''}`} />
                      {isDemo
                        ? uiText(uiLanguage, '演示模式', 'Demo mode')
                        : connectionState === 'connected'
                          ? uiText(uiLanguage, '安全连接', 'Secure connection')
                          : connectionState === 'offline'
                            ? uiText(uiLanguage, '电脑离线', 'Computer offline')
                            : uiText(uiLanguage, '正在重连', 'Reconnecting')}
                    </>
                  ) : (
                    <>
                      <i className="online-dot online-dot--direct" />
                      {uiText(uiLanguage, '手机直连模型', 'Direct from phone')}
                    </>
                  )}
                </small>
              </div>
            </div>
            <div className="module-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeModule === 'direct'}
                className={activeModule === 'direct' ? 'active' : ''}
                onClick={() => setActiveModule('direct')}
              >
                <IonIcon icon={chatbubbleEllipsesOutline} />
                {uiText(uiLanguage, '聊天', 'Chat')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeModule === 'remote'}
                className={activeModule === 'remote' ? 'active' : ''}
                onClick={() => setActiveModule('remote')}
              >
                <IonIcon icon={desktopOutline} />
                {uiText(uiLanguage, '远程', 'Remote')}
              </button>
            </div>
            {activeModule === 'remote' && (
              <IonButtons slot="end">
                <IonButton className="toolbar-scan-button" aria-label={uiLanguage === 'en' ? 'Scan pairing QR code' : '扫描配对二维码'} onClick={() => setPairingOpen(true)}>
                  <IonIcon slot="icon-only" icon={qrCodeOutline} />
                </IonButton>
                <IonButton aria-label={uiLanguage === 'en' ? 'Settings' : '设置'} onClick={() => setSettingsOpen(true)}>
                  <IonIcon slot="icon-only" icon={settingsOutline} />
                </IonButton>
              </IonButtons>
            )}
          </IonToolbar>
        </IonHeader>

        {activeModule === 'direct' ? (
          <IonContent fullscreen className="app-content app-content--direct">
            <DirectChatView language={uiLanguage} />
          </IonContent>
        ) : remoteSnapshot ? (
          <>
            <IonContent fullscreen className="app-content">
              <IonRefresher slot="fixed" onIonRefresh={refresh}>
                <IonRefresherContent pullingText={uiText(uiLanguage, '下拉刷新', 'Pull to refresh')} refreshingSpinner="crescent" />
              </IonRefresher>
              <main className="page-shell">
                {activeTab === 'home' && <HomeView language={uiLanguage} snapshot={remoteSnapshot} connected={connectionState === 'connected'} surface={remoteSurface} onSurfaceChange={setRemoteSurface} onNavigate={setActiveTab} onCancel={cancelCurrentTask} onSelectProject={switchProject} onSelectSession={selectProjectSession} />}
                {activeTab === 'runs' && <RunsView language={uiLanguage} snapshot={remoteSnapshot} surface={remoteSurface} onSurfaceChange={setRemoteSurface} artifacts={artifacts} artifactsLoading={artifactsLoading} onRefreshArtifacts={() => void loadArtifacts()} onOpenArtifact={setViewerArtifactPath} onCancel={cancelCurrentTask} />}
                {activeTab === 'chat' && (
                  <ChatView
                    messages={messages}
                    composer={composer}
                    setComposer={setComposer}
                    onSend={sendMessage}
                    attachments={chatAttachments}
                    setAttachments={setChatAttachments}
                    processingAttachments={processingChatAttachments}
                    onProcessingAttachmentsChange={setProcessingChatAttachments}
                    fileInputRef={chatFileInputRef}
                    deviceName={remoteSnapshot.device.name}
                    workspaceName={remoteSnapshot.device.workspace}
                    connected={connectionState === 'connected'}
                    cachedAt={offlineCacheAt}
                    surface={remoteSurface}
                    onSurfaceChange={setRemoteSurface}
                    language={uiLanguage}
                  />
                )}
                {activeTab === 'approvals' && (
                  <ApprovalsView language={uiLanguage} snapshot={remoteSnapshot} onOpen={setActionApprovalId} />
                )}
              </main>
            </IonContent>

            <IonFooter className="app-tabs">
              <IonTabBar>
                {localizedTabs.map(item => (
                  <IonTabButton
                    key={item.id}
                    tab={item.id}
                    selected={activeTab === item.id}
                    onClick={() => setActiveTab(item.id)}
                  >
                    <span className="tab-icon-wrap">
                      <IonIcon icon={item.icon} />
                      {item.id === 'approvals' && remoteSnapshot.approvals.length > 0 && (
                        <i className="tab-notice">{remoteSnapshot.approvals.length}</i>
                      )}
                    </span>
                    <IonLabel>{item.label}</IonLabel>
                  </IonTabButton>
                ))}
              </IonTabBar>
            </IonFooter>
          </>
        ) : null}

        {remoteSnapshot && (
          <>
            <PairingModal
              open={pairingOpen}
              isDemo={isDemo}
              deviceName={gatewayClient.currentConfig.deviceName || remoteSnapshot.device.name}
              onDismiss={() => setPairingOpen(false)}
              onPair={applyPairing}
              onUseDemo={switchToDemo}
              language={uiLanguage}
            />
            <SettingsModal
              open={settingsOpen}
              onDismiss={() => setSettingsOpen(false)}
              chatFontScale={chatFontScale}
              onChatFontScaleChange={setChatFontScale}
              language={uiLanguage}
              onLanguageChange={setUiLanguage}
            />
            <ProjectModal
              open={projectsOpen}
              projects={remoteSnapshot.projects || []}
              activeProjectId={remoteSnapshot.activeProjectId || ''}
              onDismiss={() => setProjectsOpen(false)}
              onSelect={switchProject}
              language={uiLanguage}
            />
            <ApprovalDetailModal
              approval={remoteSnapshot.approvals.find(item => item.id === actionApprovalId) || null}
              onDismiss={() => setActionApprovalId(null)}
              onDecide={decideApproval}
              language={uiLanguage}
            />
            <ArtifactViewerModal
              path={viewerArtifactPath}
              onDismiss={() => setViewerArtifactPath(null)}
              language={uiLanguage}
            />
          </>
        )}
        <IonToast
          isOpen={Boolean(toast)}
          message={toast?.message}
          color={toast?.color}
          duration={2200}
          position="top"
          onDidDismiss={() => setToast(null)}
        />
      </IonPage>
    </IonApp>
  );
}

/** Code / Work surface switch shared by the remote Home / Runs / Chat views.
 *  It only decides where the NEXT message is sent (`surface` in
 *  POST /v1/chat/messages); history stays server-authoritative. */
function SurfaceSwitch({
  language,
  surface,
  onSurfaceChange,
}: {
  language: UiLanguage;
  surface: RemoteSurface;
  onSurfaceChange: (surface: RemoteSurface) => void;
}) {
  return (
    <div className="surface-switch" role="tablist" aria-label={uiText(language, '目标', 'Target')}>
      <button
        type="button"
        role="tab"
        aria-selected={surface === 'code'}
        className={surface === 'code' ? 'active' : ''}
        onClick={() => onSurfaceChange('code')}
      >
        <IonIcon icon={codeSlashOutline} />
        {uiText(language, 'Code', 'Code')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={surface === 'work'}
        className={surface === 'work' ? 'active' : ''}
        onClick={() => onSurfaceChange('work')}
      >
        <IonIcon icon={documentTextOutline} />
        {uiText(language, 'Work', 'Work')}
      </button>
    </div>
  );
}

function HomeView({
  language,
  snapshot,
  connected,
  surface,
  onSurfaceChange,
  onNavigate,
  onCancel,
  onSelectProject,
  onSelectSession,
}: {
  language: UiLanguage;
  snapshot: RemoteSnapshot;
  connected: boolean;
  surface: RemoteSurface;
  onSurfaceChange: (surface: RemoteSurface) => void;
  onNavigate: (tab: TabId) => void;
  onCancel: () => void;
  onSelectProject: (projectId: string) => Promise<void>;
  onSelectSession: (sessionId: string) => Promise<void>;
}) {
  const { device, agent, sessions, approvals } = snapshot;
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(() => snapshot.activeProjectId ? [snapshot.activeProjectId] : []);
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, RemoteSnapshot['sessions']>();
    sessions.forEach(session => {
      const projectId = session.workspace?.id || 'unassigned';
      grouped.set(projectId, [...(grouped.get(projectId) || []), session]);
    });
    grouped.forEach(items => items.sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt)));
    return grouped;
  }, [sessions]);
  const visibleProjects = useMemo(() => {
    const known = new Map(snapshot.projects.map(project => [project.id, project]));
    sessions.forEach(session => {
      const workspace = session.workspace;
      if (workspace?.id && !known.has(workspace.id)) {
        known.set(workspace.id, { id: workspace.id, name: workspace.name || 'Project', path: workspace.path, lastSeenAt: Number(session.updatedAt) || 0 });
      }
    });
    return Array.from(known.values()).sort((left, right) => left.id === snapshot.activeProjectId ? -1 : right.id === snapshot.activeProjectId ? 1 : Number(right.lastSeenAt) - Number(left.lastSeenAt));
  }, [snapshot.projects, snapshot.activeProjectId, sessions]);
  const toggleProject = (projectId: string) => setExpandedProjectIds(current => current.includes(projectId) ? current.filter(id => id !== projectId) : [...current, projectId]);
  useEffect(() => {
    if (!snapshot.activeProjectId) return;
    setExpandedProjectIds(current => current.includes(snapshot.activeProjectId) ? current : [...current, snapshot.activeProjectId]);
  }, [snapshot.activeProjectId]);
  return (
    <div className="view-stack home-view">
      <div className="device-strip">
        <div className="device-icon"><IonIcon icon={desktopOutline} /></div>
        <div className="device-copy">
          <span>{device.name}</span>
          <small><IonIcon icon={folderOpenOutline} />{device.workspace}</small>
        </div>
        {connected ? (
          <IonChip className="latency-chip"><IonIcon icon={wifiOutline} /> {device.latencyMs} ms</IonChip>
        ) : (
          <IonChip className="latency-chip latency-chip--offline"><IonIcon icon={wifiOutline} /> {uiText(language, '未连接', 'Offline')}</IonChip>
        )}
      </div>

      <SurfaceSwitch language={language} surface={surface} onSurfaceChange={onSurfaceChange} />

      <section className="project-browser">
        <div className="project-browser-heading"><div><span className="eyebrow">WORKSPACES</span><h2>{uiText(language, '项目与对话', 'Projects and chats')}</h2></div><span>{visibleProjects.length} {uiText(language, '个项目', 'projects')}</span></div>
        <div className="project-tree">
          {visibleProjects.map(project => {
            const projectSessions = sessionsByProject.get(project.id) || [];
            const expanded = expandedProjectIds.includes(project.id);
            const active = project.id === snapshot.activeProjectId;
            return <article className={`project-tree-group${active ? ' project-tree-group--active' : ''}`} key={project.id}>
              <button type="button" className="project-tree-head" aria-expanded={expanded} onClick={() => toggleProject(project.id)}>
                <span className="project-tree-folder"><IonIcon icon={folderOpenOutline} /></span>
                <span className="project-tree-copy"><strong>{project.name}</strong><small>{active ? uiText(language, '当前项目', 'Current project') : formatRecentTime(project.lastSeenAt, language)} · {projectSessions.length} {uiText(language, '个对话', 'chats')}</small></span>
                <IonIcon className={`project-tree-chevron${expanded ? ' expanded' : ''}`} icon={chevronForward} />
              </button>
              {expanded && <div className="project-tree-sessions">
                {projectSessions.map(session => <button type="button" className={`project-tree-session${session.id === snapshot.activeSessionId ? ' active' : ''}`} key={session.id} onClick={() => void onSelectSession(session.id)}><span><IonIcon icon={chatbubbleEllipsesOutline} /></span><span><strong>{session.title}</strong><small>{session.preview || uiText(language, '暂无消息', 'No messages yet')}</small></span><time>{formatRecentTime(session.updatedAt, language)}</time></button>)}
                {!projectSessions.length && <button type="button" className="project-tree-empty" onClick={() => void onSelectProject(project.id)}>{active ? uiText(language, '这个项目还没有对话', 'No chats in this project yet') : uiText(language, '打开这个项目开始对话', 'Open this project to start chatting')}</button>}
              </div>}
            </article>;
          })}
        </div>
      </section>

      <IonCard className="hero-card">
        <IonCardContent>
          <div className="hero-card__topline">
            <div className="hero-status-group">
              <IonBadge color="warning"><i className="badge-pulse" />{statusLabels[language][agent.status]}</IonBadge>
              <span className="mode-pill">{modeLabels[language][agent.mode]}</span>
            </div>
            <span className="elapsed"><IonIcon icon={timeOutline} /> {agent.elapsed}</span>
          </div>
          <h1>{agent.title}</h1>
          <p>{agent.detail}</p>
          <div className="progress-row">
            <IonProgressBar value={agent.progress / 100} />
            <strong>{agent.progress}%</strong>
          </div>
          <div className="hero-actions">
            <IonButton fill="solid" onClick={() => onNavigate('runs')}>
              {uiText(language, '查看执行过程', 'View run details')}<IonIcon slot="end" icon={arrowForward} />
            </IonButton>
            <IonButton fill="clear" color="medium" onClick={onCancel}>
              <IonIcon slot="start" icon={stopCircleOutline} />{uiText(language, '停止', 'Stop')}
            </IonButton>
          </div>
        </IonCardContent>
      </IonCard>

      <div className="metric-grid">
        <button className="metric-card ion-activatable" onClick={() => onNavigate('runs')}>
          <IonRippleEffect />
          <span className="metric-icon metric-icon--purple"><IonIcon icon={flash} /></span>
          <strong>{agent.timeline.filter(event => event.state === 'done').length}</strong>
          <small>{uiText(language, '已完成步骤', 'Completed steps')}</small>
        </button>
        <button className="metric-card ion-activatable" onClick={() => onNavigate('chat')}>
          <IonRippleEffect />
          <span className="metric-icon metric-icon--blue"><IonIcon icon={chatbubbleEllipsesOutline} /></span>
          <strong>{sessions.length}</strong>
          <small>{uiText(language, '最近会话', 'Recent chats')}</small>
        </button>
        <button className="metric-card ion-activatable" onClick={() => onNavigate('approvals')}>
          <IonRippleEffect />
          <span className="metric-icon metric-icon--amber"><IonIcon icon={shieldCheckmarkOutline} /></span>
          <strong>{approvals.length}</strong>
          <small>{uiText(language, '等待审批', 'Approvals')}</small>
        </button>
      </div>

      <section className="content-section">
        <div className="section-heading">
          <div><span className="eyebrow">CONTINUE</span><h2>{uiText(language, '最近会话', 'Recent chats')}</h2></div>
          <IonButton fill="clear" size="small" onClick={() => onNavigate('chat')}>{uiText(language, '查看全部', 'View all')}</IonButton>
        </div>
        <IonList className="session-list" lines="none">
          {sessions.slice(0, 2).map(session => (
            <IonItem button detail={false} key={session.id} onClick={() => onNavigate('chat')}>
              <div className="session-symbol" slot="start"><IonIcon icon={codeSlashOutline} /></div>
              <IonLabel>
              <div className="session-title-row"><strong>{session.title}</strong><IonNote>{formatRecentTime(session.updatedAt, language)}</IonNote></div>
                <p>{session.preview}</p>
              </IonLabel>
              <IonIcon icon={chevronForward} slot="end" color="medium" />
            </IonItem>
          ))}
        </IonList>
      </section>
    </div>
  );
}

function RunsView({ language, snapshot, surface, onSurfaceChange, artifacts, artifactsLoading, onRefreshArtifacts, onOpenArtifact, onCancel }: { language: UiLanguage; snapshot: RemoteSnapshot; surface: RemoteSurface; onSurfaceChange: (surface: RemoteSurface) => void; artifacts: RemoteArtifact[]; artifactsLoading: boolean; onRefreshArtifacts: () => void; onOpenArtifact: (path: string) => void; onCancel: () => void }) {
  const { agent } = snapshot;
  const completedCount = agent.timeline.filter(event => event.state === 'done').length;
  const currentEvent = agent.timeline.find(event => event.state === 'active');
  const visibleTimeline = agent.timeline.slice(-6);
  const hiddenTimelineCount = Math.max(0, agent.timeline.length - visibleTimeline.length);
  const activeKind = currentEvent?.kind || visibleTimeline[visibleTimeline.length - 1]?.kind || 'thinking';
  const activeStage = agent.status === 'done'
    ? 3
    : activeKind === 'change' || activeKind === 'command' || activeKind === 'approval'
      ? 2
      : activeKind === 'inspect'
        ? 1
        : 0;
  const stages = language === 'en' ? ['Understand', 'Inspect', 'Execute', 'Finish'] : ['理解', '查看', '执行', '完成'];
  return (
    <div className="view-stack runs-view">
      <SurfaceSwitch language={language} surface={surface} onSurfaceChange={onSurfaceChange} />
      <IonCard className={`run-focus-card run-focus-card--${agent.status}`}>
        <IonCardContent>
          <div className="run-focus-topline">
              <span className="mode-pill mode-pill--prominent"><i />{surface === 'work' ? uiText(language, 'Work', 'Work') : uiText(language, 'Code', 'Code')} · {modeLabels[language][agent.mode]}</span>
            <span className="elapsed"><IonIcon icon={timeOutline} />{agent.elapsed}</span>
          </div>
          <div className="run-focus-copy">
            <div className="run-orbit"><IonIcon icon={agent.status === 'done' ? checkmarkCircle : playOutline} /></div>
            <div><span>{statusLabels[language][agent.status]}</span><h1>{agent.title}</h1><p>{currentEvent?.detail || agent.detail}</p></div>
          </div>
          <IonProgressBar value={agent.progress / 100} />
          <div className="run-facts">
            <span><b>{agent.progress}%</b> {uiText(language, '总进度', 'Progress')}</span>
            <span><b>{completedCount}</b> {uiText(language, '有效步骤', 'Steps')}</span>
            <span><b>{snapshot.approvals.length}</b> {uiText(language, '待审批', 'Approvals')}</span>
          </div>
          <div className="run-stage-strip" aria-label="任务阶段">
            {stages.map((stage, index) => (
              <div className={`run-stage${index < activeStage ? ' run-stage--done' : index === activeStage ? ' run-stage--active' : ''}`} key={stage}>
                <i>{index < activeStage ? <IonIcon icon={checkmarkCircle} /> : index + 1}</i>
                <span>{stage}</span>
              </div>
            ))}
          </div>
        </IonCardContent>
      </IonCard>

      {agent.finalResponse && (
        <section className="final-response-card">
          <div className="final-response-heading">
            <span className="result-mark"><IonIcon icon={checkmarkCircle} /></span>
            <div><span className="eyebrow">RESULT</span><h2>{uiText(language, '最终回复', 'Final response')}</h2></div>
            <time>{formatChatTime(agent.finalResponse.at, language)}</time>
          </div>
          <MarkdownMessage text={agent.finalResponse.text} language={language} />
        </section>
      )}

      <section className="content-section">
        <div className="section-heading">
          <div><span className="eyebrow">PROGRESS</span><h2>{uiText(language, '最近关键步骤', 'Recent key steps')}</h2></div>
          {(agent.technicalEventCount + hiddenTimelineCount) > 0 && <span className="filtered-events">{uiText(language, `已收起 ${agent.technicalEventCount + hiddenTimelineCount} 条`, `${agent.technicalEventCount + hiddenTimelineCount} hidden`)}</span>}
        </div>
        {agent.timeline.length ? (
          <div className="timeline timeline--compact">
            {visibleTimeline.map((event, index) => (
              <div className={`timeline-event timeline-event--${event.state}`} key={event.id}>
                <div className="timeline-rail">
                  <span><IonIcon icon={event.state === 'done' ? checkmarkCircle : timelineIcons[event.kind || 'progress']} /></span>
                </div>
                <div className="timeline-copy">
                  <div><strong>{event.title}</strong><time>{event.at}</time></div>
                  {event.detail && <p>{event.detail}</p>}
                  {event.state === 'active' && <div className="active-line"><i /><i /><i /></div>}
                  <small>{uiText(language, '步骤', 'Step')} {agent.timeline.length - visibleTimeline.length + index + 1}</small>
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState icon={hardwareChipOutline} title={uiText(language, '等待任务开始', 'Waiting for a task')} detail={uiText(language, '电脑端开始执行后，关键步骤会实时出现在这里。', 'Key steps will appear here as the computer runs the task.')} />}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div><span className="eyebrow">DELIVERABLES</span><h2>{uiText(language, '产物', 'Artifacts')}</h2></div>
          <IonButton fill="clear" size="small" disabled={artifactsLoading} onClick={onRefreshArtifacts}>{artifactsLoading ? uiText(language, '读取中', 'Loading') : uiText(language, '刷新', 'Refresh')}</IonButton>
        </div>
        {artifacts.length === 0 && !artifactsLoading ? (
          <EmptyState icon={documentTextOutline} title={uiText(language, '还没有产物', 'No artifacts yet')} detail={uiText(language, 'Work 任务生成的文档会出现在电脑 .trylo/out 里，这里只读展示。', 'Docs produced by Work tasks land in the computer’s .trylo/out and show up here read-only.')} />
        ) : (
          <IonList className="session-list" lines="none">
            {artifacts.map(item => (
              <IonItem button detail={false} key={item.id} onClick={() => onOpenArtifact(item.id)}>
                <div className="session-symbol" slot="start"><IonIcon icon={documentTextOutline} /></div>
                <IonLabel>
                  <div className="session-title-row"><strong>{item.name}</strong><IonNote>{formatBytes(item.size)}</IonNote></div>
                  <p>{formatRecentTime(item.modifiedAt, language)}</p>
                </IonLabel>
                <IonIcon icon={chevronForward} slot="end" color="medium" />
              </IonItem>
            ))}
          </IonList>
        )}
      </section>

      {!['idle', 'done', 'failed'].includes(agent.status) && (
        <IonButton className="stop-button" expand="block" fill="outline" color="danger" onClick={onCancel}>
          <IonIcon slot="start" icon={stopCircleOutline} />{uiText(language, '停止当前任务', 'Stop current task')}
        </IonButton>
      )}
    </div>
  );
}

function ChatView({
  language,
  messages,
  composer,
  setComposer,
  onSend,
  attachments,
  setAttachments,
  processingAttachments,
  onProcessingAttachmentsChange,
  fileInputRef,
  deviceName,
  workspaceName,
  connected,
  cachedAt,
  surface,
  onSurfaceChange,
}: {
  language: UiLanguage;
  messages: RemoteChatMessage[];
  composer: string;
  setComposer: (value: string) => void;
  onSend: () => void;
  attachments: DirectAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<DirectAttachment[]>>;
  processingAttachments: boolean;
  onProcessingAttachmentsChange: (value: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  deviceName: string;
  workspaceName: string;
  connected: boolean;
  cachedAt: number | null;
  surface: RemoteSurface;
  onSurfaceChange: (surface: RemoteSurface) => void;
}) {
  const [viewerImage, setViewerImage] = useState<DirectAttachment | null>(null);

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    if (room <= 0) {
      setToastPlaceholder(uiText(language, `最多只能附带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件`, `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`));
      return;
    }
    onProcessingAttachmentsChange(true);
    const accepted: DirectAttachment[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      try {
        accepted.push(await buildAttachment(file));
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : file.name);
      }
    }
    if (accepted.length) setAttachments(current => [...current, ...accepted]);
    if (failures.length) setToastPlaceholder(failures[0]);
    onProcessingAttachmentsChange(false);
  };

  // App owns the toast; ChatView surfaces a transient notice via a callback
  // to avoid duplicating the portal/toast machinery.
  const setToastPlaceholder = (message: string) => {
    window.dispatchEvent(new CustomEvent('trylo-chat-toast', { detail: message }));
  };

  const openPicker = (accept: string) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = accept;
    input.value = '';
    input.click();
  };

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
  };

  return (
    <>
      <div className="chat-view">
        <section className="chat-context">
          <div className="context-icon"><IonIcon icon={radioOutline} /></div>
          <div><strong>{connected ? uiText(language, '远程会话已连接', 'Remote session connected') : uiText(language, '正在恢复远程连接', 'Restoring remote connection')}</strong><span>{deviceName} · {workspaceName}</span></div>
          <IonBadge color={connected ? 'success' : 'medium'}>{connected ? uiText(language, '实时', 'Live') : uiText(language, '离线', 'Offline')}</IonBadge>
        </section>
        <SurfaceSwitch language={language} surface={surface} onSurfaceChange={onSurfaceChange} />
        {cachedAt !== null && (
          <p className="mode-follow-note"><IonIcon icon={informationCircleOutline} /> {uiText(language, `电脑离线，显示本机缓存（${formatRecentTime(cachedAt, language)}），恢复连接后自动更新。`, `Computer offline — showing the on-device cache (${formatRecentTime(cachedAt, language)}). It refreshes on reconnect.`)}</p>
        )}
        <p className="mode-follow-note"><IonIcon icon={informationCircleOutline} /> {surface === 'work'
          ? uiText(language, '发往电脑 Work（文档/表格/演示/网页任务）。', 'Goes to desktop Work (docs / sheets / decks / web).')
          : uiText(language, '发往电脑 Code（写代码、改文件、跑命令）。', 'Goes to desktop Code (write code, edit files, run commands).')}</p>
        <p className="mode-follow-note"><IonIcon icon={informationCircleOutline} /> {uiText(language, '当前会话与电脑端双向同步，包含提问、思考摘要和最终回复。', 'This conversation syncs both ways, including prompts, thinking, and final responses.')}</p>

        <div className="message-list">
          <div className="day-divider"><span>{uiText(language, '今天', 'Today')}</span></div>
          {messages.map(message => (
            <div className={`message-row message-row--${message.role}`} key={message.id}>
              {message.role === 'assistant' && <IonAvatar><BrandMark small /></IonAvatar>}
              {message.role === 'thinking' && <span className="thinking-avatar"><IonIcon icon={trailSignOutline} /></span>}
              <div className={`message-bubble${message.role !== 'user' && hasWideMarkdownBlock(message.text) ? ' message-bubble--wide' : ''}`}>
                {message.role === 'thinking' && <strong>{message.title || uiText(language, '思考摘要', 'Thinking')}</strong>}
                {message.role === 'user' && message.attachments && message.attachments.length > 0 ? (
                  <AttachmentStrip attachments={message.attachments} language={language} onOpenImage={setViewerImage} />
                ) : null}
                <MarkdownMessage text={message.text || uiText(language, '正在输入…', 'Typing…')} language={language} />
                <div className="message-meta"><span>{message.mode ? modeLabels[language][message.mode] : ''}</span><time>{message.status === 'streaming' ? uiText(language, '正在思考', 'Thinking') : formatChatTime(message.at, language)}</time></div>
              </div>
            </div>
          ))}
        </div>

        <div className="composer-wrap">
          {attachments.length > 0 && (
            <div className="chat-attach-tray">
              {attachments.map(item => (
                <div className={`chat-attach-chip chat-attach-chip--${item.kind}`} key={item.id}>
                  {item.kind === 'image' && item.dataUrl
                    ? <img className="chat-attach-chip__thumb" src={item.dataUrl} alt={item.name} />
                    : <span className="chat-attach-chip__icon"><IonIcon icon={documentTextOutline} /></span>}
                  <span className="chat-attach-chip__meta">
                    <strong>{item.name}</strong>
                    <small>{formatBytes(item.size)}</small>
                  </span>
                  <button
                    type="button"
                    className="chat-attach-chip__remove"
                    aria-label={uiText(language, '移除附件', 'Remove attachment')}
                    onClick={() => removeAttachment(item.id)}
                  >
                    <IonIcon icon={closeOutline} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-composer-row">
            <div className="chat-attach-actions">
              <button
                type="button"
                className="chat-attach-btn"
                aria-label={uiText(language, '添加图片', 'Add image')}
                disabled={processingAttachments}
                onClick={() => openPicker('image/*')}
              >
                <IonIcon icon={processingAttachments ? sparklesOutline : imageOutline} />
              </button>
              <button
                type="button"
                className="chat-attach-btn"
                aria-label={uiText(language, '添加文件', 'Add file')}
                disabled={processingAttachments}
                onClick={() => openPicker('.txt,.md,.json,.csv,.log,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.java,.kt,.go,.rs,.c,.h,.cpp,.cs,.php,.rb,.swift,.sql,.sh,.ps1,.html,.css,.xml,text/*')}
              >
                <IonIcon icon={attachOutline} />
              </button>
            </div>
            <IonTextarea
              value={composer}
              autoGrow
              rows={1}
              maxlength={2000}
              placeholder={uiText(language, '继续当前电脑会话…', 'Continue the computer conversation…')}
              onIonInput={event => setComposer(String(event.detail.value || ''))}
            />
            <IonButton
              shape="round"
              aria-label={uiText(language, '发送', 'Send')}
              disabled={(!composer.trim() && !attachments.length) || processingAttachments}
              onClick={onSend}
            >
              <IonIcon slot="icon-only" icon={paperPlane} />
            </IonButton>
          </div>
        </div>
        <p className="composer-hint"><IonIcon icon={lockClosedOutline} /> {uiText(language, '通过加密通道发送', 'Sent through an encrypted channel')}</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        onChange={event => void pickFiles(event.target.files)}
      />

      <IonModal
        isOpen={Boolean(viewerImage)}
        onDidDismiss={() => setViewerImage(null)}
        className="chat-image-viewer"
      >
        <div className="chat-image-viewer__body">
          {viewerImage?.dataUrl && (
            <img src={viewerImage.dataUrl} alt={viewerImage.name} />
          )}
          <button
            type="button"
            className="chat-image-viewer__close"
            aria-label={uiText(language, '关闭', 'Close')}
            onClick={() => setViewerImage(null)}
          >
            <IonIcon icon={closeOutline} />
          </button>
          <p className="chat-image-viewer__note">
            {uiText(language, '历史记录中只保留缩略图，因此这里画质较低。', 'History keeps a thumbnail only, so this preview is low-res.')}
          </p>
        </div>
      </IonModal>
    </>
  );
}

function ArtifactViewerModal({
  path,
  onDismiss,
  language,
}: {
  path: string | null;
  onDismiss: () => void;
  language: UiLanguage;
}) {
  const [viewer, setViewer] = useState<{
    status: 'loading' | 'ready' | 'error';
    url?: string;
    text?: string;
    mime?: string;
    name?: string;
    size?: number;
    error?: string;
  }>({ status: 'loading' });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setViewer({ status: 'loading' });
    gatewayClient.getArtifactContent(path).then(async content => {
      if (cancelled) return;
      if (content.mimeType.startsWith('image/')) {
        objectUrl = URL.createObjectURL(content.blob);
        setViewer({ status: 'ready', url: objectUrl, mime: content.mimeType, name: content.name, size: content.blob.size });
      } else if (
        content.mimeType.startsWith('text/') || content.mimeType === 'application/json' || content.mimeType.endsWith('+json')
      ) {
        const raw = await content.blob.text();
        if (cancelled) return;
        setViewer({ status: 'ready', text: raw.slice(0, 20_000), mime: content.mimeType, name: content.name, size: content.blob.size });
      } else {
        setViewer({ status: 'ready', mime: content.mimeType, name: content.name, size: content.blob.size });
      }
    }).catch(error => {
      if (!cancelled) setViewer({ status: 'error', error: error instanceof Error ? error.message : '产物打开失败' });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return (
    <IonModal isOpen={path !== null} onDidDismiss={onDismiss} className="direct-image-viewer">
      <div className="direct-image-viewer__body">
        <h2 className="artifact-viewer__title">{viewer.name || path}</h2>
        {viewer.status === 'loading' && <IonSpinner name="crescent" />}
        {viewer.status === 'error' && <p className="artifact-viewer__note">{viewer.error}</p>}
        {viewer.status === 'ready' && viewer.url && (
          <img src={viewer.url} alt={viewer.name} />
        )}
        {viewer.status === 'ready' && viewer.text !== undefined && (
          <pre className="artifact-viewer__text"><code>{viewer.text}</code></pre>
        )}
        {viewer.status === 'ready' && !viewer.url && viewer.text === undefined && (
          <p className="artifact-viewer__note">
            {uiText(language, `手机暂不支持预览此格式（${viewer.mime || '未知'}${viewer.size ? `，${formatBytes(viewer.size)}` : ''}），请在电脑端打开 .trylo/out。`, `This format (${viewer.mime || 'unknown'}) cannot be previewed on the phone. Open it under .trylo/out on the computer.`)}
          </p>
        )}
        <button
          type="button"
          className="direct-image-viewer__close"
          aria-label={uiText(language, '关闭', 'Close')}
          onClick={onDismiss}
        >
          <IonIcon icon={closeOutline} />
        </button>
      </div>
    </IonModal>
  );
}

function ApprovalsView({ language, snapshot, onOpen }: { language: UiLanguage; snapshot: RemoteSnapshot; onOpen: (id: string) => void }) {
  return (
    <div className="view-stack approvals-view">
      <section className="page-intro">
        <span className="eyebrow">PERMISSIONS</span>
        <h1>{uiText(language, '权限审批', 'Approvals')}</h1>
        <p>{uiText(language, '敏感操作必须由你明确允许，Trylo 不会自动跳过确认。', 'Sensitive actions require your explicit approval.')}</p>
      </section>

      {snapshot.approvals.length === 0 ? (
        <EmptyState icon={shieldCheckmarkOutline} title={uiText(language, '没有待处理请求', 'No pending requests')} detail={uiText(language, '新的权限申请会立即出现在这里。', 'New approval requests will appear here immediately.')} />
      ) : snapshot.approvals.map(approval => (
        <IonCard className="approval-card" key={approval.id}>
          <IonCardContent>
            <div className="approval-topline">
              <div className={`approval-icon approval-icon--${approval.risk}`}>
                <IonIcon icon={approval.category === 'command' ? terminalOutline : alertCircleOutline} />
              </div>
              <div><IonBadge color="warning"><i />{uiText(language, '等待决定', 'Pending')}</IonBadge><span>{formatChatTime(approval.requestedAt, language)}</span></div>
            </div>
            <h2>{approval.title}</h2>
            <p className="approval-summary">{approval.description || uiText(language, '电脑端正在等待你确认这项敏感操作。', 'The computer is waiting for your approval.')}</p>
            <div className="approval-preview-label"><span>{approval.category === 'command' ? 'COMMAND' : 'TARGET'}</span><small>{uiText(language, '点击查看完整内容', 'Tap for full details')}</small></div>
            <div className="command-preview"><code>{approval.detail || approval.blockedPath || uiText(language, '等待电脑端提供详细内容', 'Waiting for details from the computer')}</code></div>
            <div className="approval-note">
              <IonIcon icon={shieldCheckmarkOutline} />
              <p><strong>{uiText(language, '单次授权', 'One-time approval')}</strong><span>{uiText(language, '允许后仅执行以上操作，不会改变后续权限设置。', 'Approval applies only to this action.')}</span></p>
            </div>
            <IonButton className="approval-open-button" expand="block" onClick={() => onOpen(approval.id)}>
              {uiText(language, '查看详情并决定', 'Review and decide')}<IonIcon slot="end" icon={arrowForward} />
            </IonButton>
          </IonCardContent>
        </IonCard>
      ))}

      <section className="security-note">
        <IonIcon icon={lockClosedOutline} />
        <div><strong>{uiText(language, '审批记录保存在电脑端', 'Approvals stay on the computer')}</strong><p>{uiText(language, 'App 不会保存工作区文件、API Key 或 Claude 凭据。', 'The app does not store workspace files, API keys, or Claude credentials.')}</p></div>
      </section>
    </div>
  );
}

function ApprovalDetailModal({
  language,
  approval,
  onDismiss,
  onDecide,
}: {
  language: UiLanguage;
  approval: RemoteSnapshot['approvals'][number] | null;
  onDismiss: () => void;
  onDecide: (decision: 'allow' | 'deny') => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null);
  useEffect(() => {
    if (!approval) setSubmitting(null);
  }, [approval]);
  const decide = async (decision: 'allow' | 'deny') => {
    setSubmitting(decision);
    const accepted = await onDecide(decision);
    if (!accepted) setSubmitting(null);
  };
  if (!approval) return null;
  const categoryLabel = approval.category === 'command'
    ? uiText(language, '执行命令', 'Run command')
    : approval.category === 'network'
      ? uiText(language, '网络访问', 'Network access')
      : uiText(language, '修改文件', 'Modify files');
  return (
    <IonModal isOpen onDidDismiss={onDismiss} initialBreakpoint={0.88} breakpoints={[0, 0.88, 1]}>
      <IonHeader className="approval-detail-header">
        <IonToolbar>
          <IonTitle>{uiText(language, '操作审批', 'Action approval')}</IonTitle>
          <IonButtons slot="end"><IonButton onClick={onDismiss}>{uiText(language, '关闭', 'Close')}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="approval-detail-content">
        <div className="approval-detail-hero">
          <span className={`approval-detail-symbol approval-detail-symbol--${approval.risk}`}><IonIcon icon={approval.category === 'command' ? terminalOutline : shieldCheckmarkOutline} /></span>
          <IonBadge color="warning">{uiText(language, '电脑正在等待', 'Computer is waiting')}</IonBadge>
          <h2>{approval.title}</h2>
          <p>{approval.description || uiText(language, '请确认下面的完整操作内容。只有你明确允许后，电脑端才会继续执行。', 'Review the full action below. The computer continues only after explicit approval.')}</p>
        </div>
        <div className="approval-detail-facts">
          <div><span>{uiText(language, '操作类型', 'Action type')}</span><strong>{categoryLabel}</strong></div>
          <div><span>{uiText(language, '申请时间', 'Requested')}</span><strong>{formatChatTime(approval.requestedAt, language)}</strong></div>
          {approval.toolName && <div><span>{uiText(language, '调用工具', 'Tool')}</span><strong>{approval.toolName}</strong></div>}
          {approval.blockedPath && <div className="approval-fact-wide"><span>{uiText(language, '目标位置', 'Target')}</span><code>{approval.blockedPath}</code></div>}
        </div>
        <section className="approval-full-detail">
          <div><span>{uiText(language, '完整操作内容', 'Full action')}</span><IonButton fill="clear" size="small" onClick={() => navigator.clipboard.writeText(approval.detail || approval.blockedPath || '')}><IonIcon slot="start" icon={copyOutline} />{uiText(language, '复制', 'Copy')}</IonButton></div>
          <pre><code>{approval.detail || approval.blockedPath || uiText(language, '电脑端未提供额外内容', 'No additional details were provided')}</code></pre>
        </section>
        {approval.decisionReason && <p className="approval-reason"><IonIcon icon={informationCircleOutline} />{approval.decisionReason}</p>}
        <div className="approval-impact-note">
          <IonIcon icon={shieldCheckmarkOutline} />
          <div><strong>{uiText(language, '只授权这一次', 'Approve once')}</strong><p>{uiText(language, '允许不会修改你的全局审批策略；下一次敏感操作仍会重新询问。', 'This does not change your global approval policy.')}</p></div>
        </div>
      </IonContent>
      <IonFooter className="approval-decision-footer">
        <IonToolbar>
          <div className="approval-decision-actions">
            <IonButton className="deny-button" fill="outline" color="danger" disabled={Boolean(submitting)} onClick={() => decide('deny')}>
              <IonIcon slot="start" icon={closeCircleOutline} />{uiText(language, '拒绝', 'Deny')}
            </IonButton>
            <IonButton className="allow-button" disabled={Boolean(submitting)} onClick={() => decide('allow')}>
              {submitting === 'allow' ? <IonSpinner slot="start" name="crescent" /> : <IonIcon slot="start" icon={checkmarkCircle} />}{uiText(language, '明确允许', 'Allow once')}
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
    </IonModal>
  );
}

function ProjectModal({
  language,
  open,
  projects,
  activeProjectId,
  onDismiss,
  onSelect,
}: {
  language: UiLanguage;
  open: boolean;
  projects: RemoteSnapshot['projects'];
  activeProjectId: string;
  onDismiss: () => void;
  onSelect: (projectId: string) => void;
}) {
  return (
    <IonModal isOpen={open} onDidDismiss={onDismiss} initialBreakpoint={0.58} breakpoints={[0, 0.58, 0.9]}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{uiText(language, '切换项目', 'Switch project')}</IonTitle>
          <IonButtons slot="end"><IonButton onClick={onDismiss}>{uiText(language, '完成', 'Done')}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="project-modal-content">
        <div className="project-modal-intro">
          <span><IonIcon icon={desktopOutline} /></span>
          <div><strong>{uiText(language, '已配对这台电脑', 'This computer is paired')}</strong><p>{uiText(language, '二维码只需扫描一次；切换项目后，历史对话和当前任务会跟着项目恢复。', 'Scan once. Conversation history and active tasks follow the selected project.')}</p></div>
        </div>
        <IonList className="project-list" lines="none">
          {projects.map(project => {
            const active = project.id === activeProjectId;
            return (
              <IonItem button detail={false} key={project.id} onClick={() => onSelect(project.id)} className={active ? 'project-item--active' : ''}>
                <div className="project-folder" slot="start"><IonIcon icon={folderOpenOutline} /></div>
                <IonLabel><strong>{project.name}</strong><p>{active ? uiText(language, '当前项目', 'Current project') : `${uiText(language, '最近打开', 'Opened')} ${formatRecentTime(project.lastSeenAt, language)}`}</p></IonLabel>
                {active ? <IonIcon slot="end" icon={checkmarkCircle} color="primary" /> : <IonIcon slot="end" icon={chevronForward} color="medium" />}
              </IonItem>
            );
          })}
        </IonList>
        {!projects.length && <EmptyState icon={folderOpenOutline} title={uiText(language, '还没有已登记项目', 'No registered projects')} detail={uiText(language, '在电脑上用 Trylo 插件打开一个项目，它就会自动出现在这里。', 'Open a project with Trylo on the computer and it will appear here.')} />}
        <p className="project-modal-note"><IonIcon icon={informationCircleOutline} />{uiText(language, '项目只需在 Trylo 插件中打开过一次，不需要重新扫码。', 'A project only needs to be opened once; no rescanning is required.')}</p>
      </IonContent>
    </IonModal>
  );
}

function PairingModal({
  open,
  isDemo,
  deviceName,
  onDismiss,
  onPair,
  onUseDemo,
  language,
}: {
  open: boolean;
  isDemo: boolean;
  deviceName: string;
  onDismiss: () => void;
  onPair: (raw: string) => Promise<void>;
  onUseDemo: () => void;
  language: UiLanguage;
}) {
  const [pairingText, setPairingText] = useState('');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const connect = async () => {
    try {
      setError('');
      await onPair(pairingText);
      setPairingText('');
    } catch (pairingError) {
      setError(pairingError instanceof Error ? pairingError.message : '无法读取配对数据。');
    }
  };
  const scanPairingCode = async () => {
    try {
      setError('');
      setScanning(true);
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: language === 'en' ? 'Place the Trylo pairing QR code in the frame' : '将 Trylo 配对二维码放入取景框',
        scanButton: false,
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
        cancelButtonAccessibilityLabel: '取消扫码',
        torchButtonOnAccessibilityLabel: '关闭手电筒',
        torchButtonOffAccessibilityLabel: '打开手电筒',
        android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING },
      });
      if (!result.ScanResult) return;
      await onPair(result.ScanResult);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : String(scanError || '');
      if (!/cancel/i.test(message)) setError(message || '无法扫描二维码，请检查相机权限。');
    } finally {
      setScanning(false);
    }
  };
  return (
    <IonModal isOpen={open} onDidDismiss={onDismiss} initialBreakpoint={0.78} breakpoints={[0, 0.78, 1]}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{language === 'en' ? 'Pair device' : '扫码连接'}</IonTitle>
          <IonButtons slot="end"><IonButton onClick={onDismiss}>{language === 'en' ? 'Done' : '完成'}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="modal-content">
        <div className="modal-hero pairing-hero">
          <div className="paired-mark"><IonIcon icon={shieldCheckmarkOutline} /></div>
          <h2>{language === 'en'
            ? isDemo ? 'Connect your computer' : `${deviceName} is paired`
            : isDemo ? '连接你的电脑' : `${deviceName} 已配对`}</h2>
          <p>{language === 'en'
            ? 'Open “Pair phone with QR code” on the computer, then scan it here.'
            : '在电脑端打开“手机扫码配对”，用相机扫描二维码即可安全连接。'}</p>
        </div>
        <div className="scan-pairing-action">
          <IonButton expand="block" size="large" onClick={scanPairingCode} disabled={scanning}>
            {scanning ? <IonSpinner slot="start" name="crescent" /> : <IonIcon slot="start" icon={qrCodeOutline} />}
            {language === 'en'
              ? scanning ? 'Opening camera…' : 'Scan pairing QR code'
              : scanning ? '正在打开相机…' : '扫描配对二维码'}
          </IonButton>
          <span>{language === 'en' ? 'Camera frames are processed only on this device.' : '相机画面仅在本机用于识别，不会上传。'}</span>
        </div>
        <div className="pairing-divider"><span>{language === 'en' ? 'or paste pairing data' : '或粘贴配对数据'}</span></div>
        <IonList inset>
          <IonItem>
            <IonIcon icon={lockClosedOutline} slot="start" />
            <IonTextarea
              label={language === 'en' ? 'Pairing data' : '配对数据'}
              labelPlacement="stacked"
              autoGrow
              rows={4}
              placeholder='{"service":"trylo-remote", ...}'
              value={pairingText}
              onIonInput={event => setPairingText(String(event.detail.value || ''))}
            />
          </IonItem>
        </IonList>
        {error && <p className="pairing-error"><IonIcon icon={alertCircleOutline} />{error}</p>}
        <div className="modal-actions">
          <IonButton expand="block" disabled={!pairingText.trim()} onClick={connect}>
            <IonIcon slot="start" icon={radioOutline} />{language === 'en' ? 'Connect with pasted data' : '使用粘贴内容连接'}
          </IonButton>
          {!isDemo && <IonButton expand="block" fill="clear" color="medium" onClick={onUseDemo}>{language === 'en' ? 'Unpair and use demo' : '解除配对并使用演示'}</IonButton>}
        </div>
      </IonContent>
    </IonModal>
  );
}

function SettingsModal({
  open,
  onDismiss,
  chatFontScale,
  onChatFontScaleChange,
  language,
  onLanguageChange,
}: {
  open: boolean;
  onDismiss: () => void;
  chatFontScale: number;
  onChatFontScaleChange: (value: number) => void;
  language: UiLanguage;
  onLanguageChange: (value: UiLanguage) => void;
}) {
  const releaseNotes = language === 'en'
    ? [
        'Version 1.0: the first public Trylo Code release',
        'Hardened provider keys, HTTPS endpoints, Android backups, external links, and remote pairing',
        'App is now Trylo Code with two sections: direct chat and remote control',
        'Chat section connects straight from your phone to your model provider with streaming replies',
        'Conversations in the chat section are saved on this device only',
        'Model settings support Doubao, DeepSeek, Qwen, Kimi, SiliconFlow, OpenAI, Anthropic, and custom endpoints',
        'API keys are stored in Android Keystore',
        'Remote pairing now uses the stable remote.trylocode.me Named Tunnel',
        'Projects now expand directly into their conversations on mobile and desktop',
        'Selecting an older conversation switches to its workspace and restores it',
        'Cat Box character art is now a full chat wallpaper instead of a header cover',
        'Create custom Cat Box roles with one local image for avatar and wallpaper',
        'Built-in character images are 43% smaller',
        'Bundled Claude Code runtime now works independently of the open folder',
        'Task progress now updates in event-driven 1% increments',
        'Pairing scanner moved to a dedicated top-bar action',
        'Cloudflare Quick Tunnel URLs now recover automatically before pairing',
        'Rebuilt the mobile experience with a calmer, product-grade visual system',
        'Cat Box now connects to the original desktop FUN characters, memory, modes, and voice',
      ]
    : [
        '版本 1.0：Trylo Code 首个正式公开版本',
        '强化服务商密钥、HTTPS 接口、Android 备份、外部链接和远程配对安全',
        'App 更名为 Trylo Code，分为「聊天」与「远程控制」两大部分',
        '聊天模块支持手机直连模型服务商，流式回复、打字效果更接近豆包',
        '聊天会话仅保存在本机，支持新建、重命名和删除',
        '模型设置支持豆包、DeepSeek、通义千问、Kimi、SiliconFlow、OpenAI、Anthropic 及自定义接口',
        'API Key 由 Android Keystore 安全存储',
        '远程配对已切换到固定的 remote.trylocode.me Named Tunnel',
        '手机与电脑端都可直接按项目展开历史对话',
        '点击旧项目对话会切换工作区并恢复该对话',
        '猫箱人物图改为完整聊天壁纸，不再占用顶部封面',
        '支持在手机端添加角色，同一图片用作头像与背景',
        '内置角色图片体积缩小约 43%',
        '内置 Claude Code 运行时，切换文件夹不再丢失 CLI',
        '任务进度改为事件驱动的 1% 级动态更新',
        '配对扫码移到顶部独立入口，不再占用设置页',
        '扫码前自动恢复 Cloudflare Quick Tunnel，不再手工填写失效地址',
        '重构移动端视觉与信息层级，更接近成熟产品体验',
        '猫箱现已接通电脑端原生 FUN：角色、记忆、双模式与语音',
      ];
  return (
    <IonModal isOpen={open} onDidDismiss={onDismiss} initialBreakpoint={0.78} breakpoints={[0, 0.78, 1]}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{language === 'en' ? 'Settings' : '设置'}</IonTitle>
          <IonButtons slot="end"><IonButton onClick={onDismiss}>{language === 'en' ? 'Done' : '完成'}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="modal-content settings-content">
        <section className="language-setting-card">
          <div className="setting-card-icon"><IonIcon icon={languageOutline} /></div>
          <div className="language-setting-copy">
            <span className="eyebrow">LANGUAGE</span>
            <h3>{language === 'en' ? 'Interface language' : '界面语言'}</h3>
            <p>{language === 'en' ? 'Choose the language used by Trylo Code.' : '选择 Trylo Code 的界面显示语言。'}</p>
          </div>
          <div className="language-options" role="group" aria-label="Interface language">
            <button type="button" className={language === 'zh' ? 'active' : ''} onClick={() => onLanguageChange('zh')}>中文</button>
            <button type="button" className={language === 'en' ? 'active' : ''} onClick={() => onLanguageChange('en')}>English</button>
          </div>
        </section>
        <section className="font-setting-card">
          <div className="font-setting-heading">
            <div><span className="eyebrow">READING</span><h3>{language === 'en' ? 'Chat text size' : '对话字体大小'}</h3></div>
            <strong>{Math.round(chatFontScale * 100)}%</strong>
          </div>
          <div className="font-setting-preview">{language === 'en' ? 'Preview text. Code blocks and tables scale with it.' : '这是一段对话内容预览，代码和表格也会同步缩放。'}</div>
          <div className="font-setting-range"><span>{language === 'en' ? 'Small' : '小'}</span><IonRange min={0.9} max={1.35} step={0.05} snaps value={chatFontScale} onIonInput={event => onChatFontScaleChange(Number(event.detail.value))} /><span className="font-setting-large">{language === 'en' ? 'Large' : '大'}</span></div>
          <div className="font-setting-presets">
            {[
              { label: language === 'en' ? 'Compact' : '紧凑', value: 0.95 },
              { label: language === 'en' ? 'Default' : '标准', value: 1.1 },
              { label: language === 'en' ? 'Comfort' : '舒适', value: 1.25 },
              { label: language === 'en' ? 'Large' : '大字', value: 1.35 },
            ].map(item => <button type="button" className={Math.abs(chatFontScale - item.value) < 0.01 ? 'active' : ''} key={item.label} onClick={() => onChatFontScaleChange(item.value)}>{item.label}</button>)}
          </div>
        </section>
        <section className="release-card">
          <div className="release-card__topline">
            <div><span className="eyebrow">TRYLO CODE</span><h3>{uiText(language, '版本', 'Version')} {APP_VERSION}</h3></div>
            <IonBadge color="light">{APP_RELEASE_DATE}</IonBadge>
          </div>
          <p>{language === 'en' ? "What's new" : '本次更新'}</p>
          <ul>
            {releaseNotes.map(note => <li key={note}>{note}</li>)}
          </ul>
        </section>
      </IonContent>
    </IonModal>
  );
}

export default App;
