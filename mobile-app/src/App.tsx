import { useEffect, useRef, useState } from "react";
import {
  IonApp,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonPage,
  IonRange,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToolbar,
} from "@ionic/react";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import {
  alertCircleOutline,
  closeOutline,
  checkmarkCircle,
  chevronForward,
  desktopOutline,
  folderOpenOutline,
  informationCircleOutline,
  languageOutline,
  lockClosedOutline,
  qrCodeOutline,
  radioOutline,
  shieldCheckmarkOutline,
} from "ionicons/icons";
import {
  BrandMark,
  EmptyState,
  UiLanguage,
  formatBytes,
  formatRecentTime,
  uiText,
} from "./ui";
import DirectChatView from "./DirectChatView";
import RemoteWorkbench from "./remote/RemoteWorkbench";
import { offlineSnapshot } from "./remoteOffline";
import {
  readLatestCachedConversation,
  saveRemoteConversation,
} from "./remoteCache";
import {
  GatewayConnectionState,
  RemoteArtifact,
  RemoteChatEvent,
  RemoteChatMessage,
  RemoteSurface,
  gatewayClient,
  parsePairingData,
  RemoteSnapshot,
} from "./gateway";
type TabId = "home" | "runs" | "chat" | "approvals";
type AppModule = "direct" | "remote";
type ToastState = {
  message: string;
  color?: string;
} | null;
const APP_VERSION = "1.7.0";
const REMOTE_SURFACE_STORAGE_KEY = "trylo.remoteSurface";
function loadRemoteSurface(): RemoteSurface {
  return localStorage.getItem(REMOTE_SURFACE_STORAGE_KEY) === "work"
    ? "work"
    : "code";
}
function App() {
  const [activeModule, setActiveModule] = useState<AppModule>(() =>
    localStorage.getItem("trylo.activeModule") === "direct"
      ? "direct"
      : "remote",
  );
  const [remoteNavigation, setRemoteNavigation] = useState({
    id: 0,
    tab: "home" as TabId,
  });
  const requestRemoteTab = (tab: TabId) => {
    setRemoteNavigation((current) => ({ id: current.id + 1, tab }));
  };
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [isDemo, setIsDemo] = useState(gatewayClient.isDemo);
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>(
      gatewayClient.isDemo ? "offline" : "connecting",
    );
  const [connectionVersion, setConnectionVersion] = useState(0);
  const snapshotRevision = useRef(0);
  const connectionEpoch = useRef(0);
  const currentSnapshot = useRef<RemoteSnapshot | null>(null);
  const controlsReady = useRef(false);
  const navigationRequest = useRef(false);
  const updateConnection = (state: GatewayConnectionState) => {
    controlsReady.current = !gatewayClient.isDemo && state === "connected";
    setConnectionState(state);
  };
  const reconnect = () => {
    ++connectionEpoch.current;
    updateConnection("connecting");
    setConnectionVersion((value) => value + 1);
  };
  const [messages, setMessages] = useState<RemoteChatMessage[]>([]);
  const [offlineCacheAt, setOfflineCacheAt] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<RemoteArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactError, setArtifactError] = useState("");
  const [artifactVersion, setArtifactVersion] = useState(0);
  const [viewerArtifactPath, setViewerArtifactPath] = useState<string | null>(
    null,
  );
  const [remoteSurface, setRemoteSurface] =
    useState<RemoteSurface>(loadRemoteSurface);
  const [chatFontScale, setChatFontScale] = useState(() => {
    const stored = Number(localStorage.getItem("trylo.chatFontScale"));
    return Number.isFinite(stored) && stored >= 0.9 && stored <= 1.35
      ? stored
      : 1.1;
  });
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() =>
    localStorage.getItem("trylo.uiLanguage") === "en" ? "en" : "zh",
  );
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-font-scale",
      String(chatFontScale),
    );
    localStorage.setItem("trylo.chatFontScale", String(chatFontScale));
  }, [chatFontScale]);
  useEffect(() => {
    document.documentElement.lang = uiLanguage === "en" ? "en" : "zh-CN";
    localStorage.setItem("trylo.uiLanguage", uiLanguage);
  }, [uiLanguage]);
  useEffect(() => {
    localStorage.setItem("trylo.activeModule", activeModule);
  }, [activeModule]);
  useEffect(() => {
    localStorage.setItem(REMOTE_SURFACE_STORAGE_KEY, remoteSurface);
  }, [remoteSurface]);
  // ChatView surfaces transient notices (e.g. attachment limits) through a
  // lightweight event so it does not need its own toast portal.
  useEffect(() => {
    const handler = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (message) setToast({ message, color: "warning" });
    };
    window.addEventListener("trylo-chat-toast", handler as EventListener);
    return () =>
      window.removeEventListener("trylo-chat-toast", handler as EventListener);
  }, []);
  const handleChatEvent = (event: RemoteChatEvent) => {
    const responseId = `response-${event.requestId}`;
    if (event.type === "chat_started") {
      setMessages((current) =>
        current.some((message) => message.id === responseId)
          ? current
          : current.concat({
              id: responseId,
              role: "assistant",
              text: "",
              at: event.at || Date.now(),
            }),
      );
      return;
    }
    if (event.type === "chat_delta") {
      setMessages((current) => {
        const existing = current.find((message) => message.id === responseId);
        if (!existing) {
          return current.concat({
            id: responseId,
            role: "assistant",
            text: String(event.delta || ""),
            at: event.at || Date.now(),
          });
        }
        return current.map((message) =>
          message.id === responseId
            ? { ...message, text: message.text + String(event.delta || "") }
            : message,
        );
      });
      return;
    }
    if (event.type === "chat_complete") {
      setMessages((current) =>
        current.some((message) => message.id === responseId)
          ? current.map((message) =>
              message.id === responseId
                ? { ...message, text: String(event.text || message.text) }
                : message,
            )
          : current.concat({
              id: responseId,
              role: "assistant",
              text: String(event.text || ""),
              at: event.at || Date.now(),
            }),
      );
      return;
    }
    if (event.type === "chat_error") {
      setMessages((current) =>
        current.filter((message) => message.id !== responseId),
      );
      setToast({ message: event.error || "电脑端回复失败", color: "danger" });
    }
  };
  const restoreOfflineView = () => {
    const cached = readLatestCachedConversation(
      gatewayClient.currentConfig.deviceId,
    );
    const next = offlineSnapshot(gatewayClient.currentConfig, cached);
    currentSnapshot.current = next;
    setSnapshot(next);
    setMessages(next.conversation);
    setOfflineCacheAt(cached?.at || null);
  };
  const acceptSnapshot = (next: RemoteSnapshot) => {
    ++snapshotRevision.current;
    currentSnapshot.current = next;
    setSnapshot(next);
    const activeSurface = next.sessions.find(
      (session) => session.id === next.activeSessionId,
    )?.surface;
    if (activeSurface) setRemoteSurface(activeSurface);
    setMessages(next.conversation || []);
    setOfflineCacheAt(null);
    if (!gatewayClient.isDemo)
      saveRemoteConversation(
        next.activeSessionId || "active",
        next.device.workspace,
        next.conversation || [],
        next.device.id,
        {
          projectId: next.activeProjectId,
            collaboration: next.collaboration,
          surface: activeSurface,
          title: next.sessions.find(
            (session) => session.id === next.activeSessionId,
          )?.title,
        },
      );
    setLoading(false);
  };
  const loadSnapshot = async () => {
    const revision = snapshotRevision.current;
    const epoch = connectionEpoch.current;
    try {
      const next = await gatewayClient.getSnapshot();
      if (
        epoch !== connectionEpoch.current ||
        revision !== snapshotRevision.current
      )
        return;
      acceptSnapshot(next);
    } catch (error) {
      if (
        epoch !== connectionEpoch.current ||
        revision !== snapshotRevision.current
      )
        return;
      updateConnection("offline");
      // Keep the last visible session intact. A newer cache from another
      // session must never be displayed under the current session's title.
      if (!currentSnapshot.current) restoreOfflineView();
      setToast({
        message: error instanceof Error ? error.message : "无法连接 Gateway",
        color: "danger",
      });
    } finally {
      if (epoch === connectionEpoch.current) setLoading(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    const epoch = ++connectionEpoch.current;
    let dispose = () => {};
    const connect = async () => {
      try {
        await gatewayClient.initialize();
        if (cancelled) return;
        setIsDemo(gatewayClient.isDemo);
        updateConnection(gatewayClient.isDemo ? "offline" : "connecting");
        // Subscribe independently of REST/history. A failed initial read must
        // not prevent automatic recovery when the computer comes back online.
        dispose = gatewayClient.subscribe(
          (next) => {
            if (!cancelled && epoch === connectionEpoch.current)
              acceptSnapshot(next);
          },
          (state) => {
            if (!cancelled && epoch === connectionEpoch.current)
              updateConnection(state);
          },
          (event) => {
            if (!cancelled && epoch === connectionEpoch.current)
              handleChatEvent(event);
          },
        );
        void loadSnapshot();
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        updateConnection("offline");
        if (!currentSnapshot.current) restoreOfflineView();
        setToast({
          message:
            error instanceof Error ? error.message : "安全存储初始化失败",
          color: "danger",
        });
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (connectionEpoch.current === epoch) ++connectionEpoch.current;
      dispose();
    };
  }, [connectionVersion]);
  const artifactGeneration = useRef(0);
  useEffect(() => {
    const generation = ++artifactGeneration.current;
    setArtifacts([]);
    setArtifactError("");
    if (
      activeModule !== "remote" ||
      connectionState !== "connected" ||
      gatewayClient.isDemo
    ) {
      setArtifactsLoading(false);
      return;
    }
    setArtifactsLoading(true);
    void gatewayClient
      .getArtifacts()
      .then((files) => {
        if (artifactGeneration.current === generation) setArtifacts(files);
      })
      .catch((error) => {
        if (artifactGeneration.current === generation)
          setArtifactError(
            error instanceof Error ? error.message : "无法读取项目文件",
          );
      })
      .finally(() => {
        if (artifactGeneration.current === generation)
          setArtifactsLoading(false);
      });
    return () => {
      ++artifactGeneration.current;
    };
  }, [
    activeModule,
    connectionState,
    snapshot?.device.id,
    snapshot?.activeProjectId,
    snapshot?.activeSessionId,
    snapshot?.agent.status,
    snapshot?.agent.phase,
    artifactVersion,
  ]);
  useEffect(() => {
    setViewerArtifactPath(null);
  }, [
    snapshot?.device.id,
    snapshot?.activeProjectId,
    snapshot?.activeSessionId,
  ]);
  const applyPairing = async (raw: string) => {
    const pairing = parsePairingData(raw);
    await gatewayClient.configureFromPairing(pairing);
    currentSnapshot.current = null;
    setSnapshot(null);
    setMessages([]);
    setLoading(true);
    setIsDemo(false);
    requestRemoteTab("home");
    reconnect();
    setPairingOpen(false);
    setToast({ message: `正在连接 ${pairing.deviceName}`, color: "primary" });
  };
  const switchToDemo = async () => {
    await gatewayClient.useDemo();
    currentSnapshot.current = null;
    setSnapshot(null);
    setMessages([]);
    setLoading(true);
    setIsDemo(true);
    requestRemoteTab("home");
    reconnect();
    setPairingOpen(false);
  };
  const openProjects = async () => {
    setProjectsOpen(true);
    const epoch = connectionEpoch.current;
    const deviceId = currentSnapshot.current?.device.id;
    try {
      const projectState = await gatewayClient.getProjects();
      const latest = currentSnapshot.current;
      if (
        epoch !== connectionEpoch.current ||
        !latest ||
        latest.device.id !== deviceId
      )
        return;
      // The list read supplies choices; only a full snapshot owns selection.
      const next = { ...latest, projects: projectState.projects };
      currentSnapshot.current = next;
      setSnapshot(next);
    } catch {
      // Keep the last known list while the gateway reconnects.
    }
  };
  const navigate = async (
    operation: () => Promise<unknown>,
    accepted: () => void,
    failure: string,
  ) => {
    if (!controlsReady.current || navigationRequest.current) return false;
    navigationRequest.current = true;
    setNavigationBusy(true);
    const epoch = ++connectionEpoch.current;
    updateConnection("connecting");
    try {
      await operation();
      if (epoch !== connectionEpoch.current) return false;
      accepted();
      return true;
    } catch (error) {
      if (epoch === connectionEpoch.current)
        setToast({
          message: error instanceof Error ? error.message : failure,
          color: "danger",
        });
      return false;
    } finally {
      navigationRequest.current = false;
      setNavigationBusy(false);
      // Success and uncertain failures both resynchronize before writes reopen.
      if (epoch === connectionEpoch.current)
        setConnectionVersion((value) => value + 1);
    }
  };
  const switchProject = async (projectId: string) => {
    if (!controlsReady.current || navigationRequest.current) return;
    if (!snapshot || projectId === snapshot.activeProjectId) {
      setProjectsOpen(false);
      return;
    }
    await navigate(
      () => gatewayClient.selectProject(projectId),
      () => {
        setProjectsOpen(false);
        requestRemoteTab("chat");
        setToast({
          message: "正在电脑上切换项目，连接会自动恢复",
          color: "primary",
        });
      },
      "无法切换项目",
    );
  };
  const selectProjectSession = async (sessionId: string) => {
    return navigate(
      () => gatewayClient.selectSession(sessionId),
      () => requestRemoteTab("chat"),
      uiText(uiLanguage, "无法恢复对话", "Unable to restore chat"),
    );
  };
  const createRemoteSession = async (surface = remoteSurface) => {
    return navigate(
      () => gatewayClient.createSession(surface),
      () => {
        setRemoteSurface(surface);
        setActiveModule("remote");
        requestRemoteTab("chat");
      },
      uiText(uiLanguage, "新建会话失败", "Unable to create chat"),
    );
  };
  const remoteSnapshot = snapshot;
  return (
    <IonApp className={`app-module--${activeModule}`}>
      <IonPage>
        {loading && !snapshot && activeModule === "remote" && (
          <div className="launch-screen">
            <BrandMark />
            <div className="launch-screen__copy">
              <strong>Trylo</strong>
              <span>
                {uiText(
                  uiLanguage,
                  "正在读取你的会话",
                  "Loading your conversations",
                )}
              </span>
            </div>
            <IonSpinner name="crescent" />
          </div>
        )}
        <IonContent
          hidden={activeModule !== "direct"}
          fullscreen
          className="app-content app-content--direct"
          style={{ display: activeModule === "direct" ? undefined : "none" }}
        >
          <DirectChatView
            language={uiLanguage}
            onHome={() => {
              setActiveModule("remote");
              requestRemoteTab("home");
            }}
          />
        </IonContent>
        {remoteSnapshot && (
          <RemoteWorkbench
            hidden={activeModule !== "remote"}
            navigation={remoteNavigation}
            snapshot={remoteSnapshot}
            messages={messages}
            state={connectionState}
            artifacts={artifacts}
            artifactsLoading={artifactsLoading}
            artifactError={artifactError}
            onRefreshArtifacts={() => setArtifactVersion((value) => value + 1)}
            language={uiLanguage}
            demo={isDemo}
            cachedAt={offlineCacheAt}
            onReconnect={reconnect}
            onPair={() => setPairingOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onDirect={() => setActiveModule("direct")}
            onProjects={openProjects}
            onSession={selectProjectSession}
            onCreate={createRemoteSession}
            onOpenArtifact={setViewerArtifactPath}
          />
        )}

        {remoteSnapshot && (
          <>
            <PairingModal
              open={pairingOpen}
              isDemo={isDemo}
              deviceName={
                gatewayClient.currentConfig.deviceName ||
                remoteSnapshot.device.name
              }
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
              disabled={connectionState !== "connected" || navigationBusy}
              open={projectsOpen}
              projects={remoteSnapshot.projects || []}
              activeProjectId={remoteSnapshot.activeProjectId || ""}
              onDismiss={() => setProjectsOpen(false)}
              onSelect={switchProject}
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
    status: "loading" | "ready" | "error";
    url?: string;
    text?: string;
    mime?: string;
    name?: string;
    size?: number;
    error?: string;
  }>({ status: "loading" });
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setViewer({ status: "loading" });
    gatewayClient
      .getArtifactContent(path)
      .then(async (content) => {
        if (cancelled) return;
        if (content.mimeType.startsWith("image/")) {
          objectUrl = URL.createObjectURL(content.blob);
          setViewer({
            status: "ready",
            url: objectUrl,
            mime: content.mimeType,
            name: content.name,
            size: content.blob.size,
          });
        } else if (
          content.mimeType.startsWith("text/") ||
          content.mimeType === "application/json" ||
          content.mimeType.endsWith("+json")
        ) {
          const raw = await content.blob.text();
          if (cancelled) return;
          setViewer({
            status: "ready",
            text: raw.slice(0, 20000),
            mime: content.mimeType,
            name: content.name,
            size: content.blob.size,
          });
        } else {
          setViewer({
            status: "ready",
            mime: content.mimeType,
            name: content.name,
            size: content.blob.size,
          });
        }
      })
      .catch((error) => {
        if (!cancelled)
          setViewer({
            status: "error",
            error: error instanceof Error ? error.message : "产物打开失败",
          });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return (
    <IonModal
      isOpen={path !== null}
      onDidDismiss={onDismiss}
      className="direct-image-viewer"
    >
      <div className="direct-image-viewer__body">
        <h2 className="artifact-viewer__title">{viewer.name || path}</h2>
        {viewer.status === "loading" && <IonSpinner name="crescent" />}
        {viewer.status === "error" && (
          <p className="artifact-viewer__note">{viewer.error}</p>
        )}
        {viewer.status === "ready" && viewer.url && (
          <img src={viewer.url} alt={viewer.name} />
        )}
        {viewer.status === "ready" && viewer.text !== undefined && (
          <pre className="artifact-viewer__text">
            <code>{viewer.text}</code>
          </pre>
        )}
        {viewer.status === "ready" &&
          !viewer.url &&
          viewer.text === undefined && (
            <p className="artifact-viewer__note">
              {uiText(
                language,
                `手机暂不支持预览此格式（${viewer.mime || "未知"}${viewer.size ? `，${formatBytes(viewer.size)}` : ""}），请在电脑端打开 .trylo/out。`,
                `This format (${viewer.mime || "unknown"}) cannot be previewed on the phone. Open it under .trylo/out on the computer.`,
              )}
            </p>
          )}
        <button
          type="button"
          className="direct-image-viewer__close"
          aria-label={uiText(language, "关闭", "Close")}
          onClick={onDismiss}
        >
          <IonIcon icon={closeOutline} />
        </button>
      </div>
    </IonModal>
  );
}
function ProjectModal({
  disabled,
  language,
  open,
  projects,
  activeProjectId,
  onDismiss,
  onSelect,
}: {
  disabled: boolean;
  language: UiLanguage;
  open: boolean;
  projects: RemoteSnapshot["projects"];
  activeProjectId: string;
  onDismiss: () => void;
  onSelect: (projectId: string) => void;
}) {
  return (
    <IonModal
      isOpen={open}
      onDidDismiss={onDismiss}
      initialBreakpoint={0.58}
      breakpoints={[0, 0.58, 0.9]}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>{uiText(language, "切换项目", "Switch project")}</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onDismiss}>
              {uiText(language, "完成", "Done")}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="project-modal-content">
        <div className="project-modal-intro">
          <span>
            <IonIcon icon={desktopOutline} />
          </span>
          <div>
            <strong>
              {uiText(language, "已配对这台电脑", "This computer is paired")}
            </strong>
            <p>
              {uiText(
                language,
                "二维码只需扫描一次；切换项目后，历史对话和当前任务会跟着项目恢复。",
                "Scan once. Conversation history and active tasks follow the selected project.",
              )}
            </p>
          </div>
        </div>
        <IonList className="project-list" lines="none">
          {projects.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <IonItem
                button
                disabled={disabled}
                detail={false}
                key={project.id}
                onClick={() => onSelect(project.id)}
                className={active ? "project-item--active" : ""}
              >
                <div className="project-folder" slot="start">
                  <IonIcon icon={folderOpenOutline} />
                </div>
                <IonLabel>
                  <strong>{project.name}</strong>
                  <p>
                    {active
                      ? uiText(language, "当前项目", "Current project")
                      : `${uiText(language, "最近打开", "Opened")} ${formatRecentTime(project.lastSeenAt, language)}`}
                  </p>
                </IonLabel>
                {active ? (
                  <IonIcon slot="end" icon={checkmarkCircle} color="primary" />
                ) : (
                  <IonIcon slot="end" icon={chevronForward} color="medium" />
                )}
              </IonItem>
            );
          })}
        </IonList>
        {!projects.length && (
          <EmptyState
            icon={folderOpenOutline}
            title={uiText(
              language,
              "还没有已登记项目",
              "No registered projects",
            )}
            detail={uiText(
              language,
              "在电脑上用 Trylo 插件打开一个项目，它就会自动出现在这里。",
              "Open a project with Trylo on the computer and it will appear here.",
            )}
          />
        )}
        <p className="project-modal-note">
          <IonIcon icon={informationCircleOutline} />
          {uiText(
            language,
            "项目只需在 Trylo 插件中打开过一次，不需要重新扫码。",
            "A project only needs to be opened once; no rescanning is required.",
          )}
        </p>
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
  const [pairingText, setPairingText] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const connect = async () => {
    try {
      setError("");
      await onPair(pairingText);
      setPairingText("");
    } catch (pairingError) {
      setError(
        pairingError instanceof Error
          ? pairingError.message
          : "无法读取配对数据。",
      );
    }
  };
  const scanPairingCode = async () => {
    try {
      setError("");
      setScanning(true);
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions:
          language === "en"
            ? "Place the Trylo pairing QR code in the frame"
            : "将 Trylo 配对二维码放入取景框",
        scanButton: false,
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
        cancelButtonAccessibilityLabel: "取消扫码",
        torchButtonOnAccessibilityLabel: "关闭手电筒",
        torchButtonOffAccessibilityLabel: "打开手电筒",
        android: {
          scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING,
        },
      });
      if (!result.ScanResult) return;
      await onPair(result.ScanResult);
    } catch (scanError) {
      const message =
        scanError instanceof Error
          ? scanError.message
          : String(scanError || "");
      if (!/cancel/i.test(message))
        setError(message || "无法扫描二维码，请检查相机权限。");
    } finally {
      setScanning(false);
    }
  };
  return (
    <IonModal
      isOpen={open}
      onDidDismiss={onDismiss}
      initialBreakpoint={0.78}
      breakpoints={[0, 0.78, 1]}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>{language === "en" ? "Pair device" : "扫码连接"}</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onDismiss}>
              {language === "en" ? "Done" : "完成"}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="modal-content">
        <div className="modal-hero pairing-hero">
          <div className="paired-mark">
            <IonIcon icon={shieldCheckmarkOutline} />
          </div>
          <h2>
            {language === "en"
              ? isDemo
                ? "Connect your computer"
                : `${deviceName} is paired`
              : isDemo
                ? "连接你的电脑"
                : `${deviceName} 已配对`}
          </h2>
          <p>
            {language === "en"
              ? "Open “Pair phone with QR code” on the computer, then scan it here."
              : "在电脑端打开“手机扫码配对”，用相机扫描二维码即可安全连接。"}
          </p>
        </div>
        <div className="scan-pairing-action">
          <IonButton
            expand="block"
            size="large"
            onClick={scanPairingCode}
            disabled={scanning}
          >
            {scanning ? (
              <IonSpinner slot="start" name="crescent" />
            ) : (
              <IonIcon slot="start" icon={qrCodeOutline} />
            )}
            {language === "en"
              ? scanning
                ? "Opening camera…"
                : "Scan pairing QR code"
              : scanning
                ? "正在打开相机…"
                : "扫描配对二维码"}
          </IonButton>
          <span>
            {language === "en"
              ? "Camera frames are processed only on this device."
              : "相机画面仅在本机用于识别，不会上传。"}
          </span>
        </div>
        <div className="pairing-divider">
          <span>
            {language === "en" ? "or paste pairing data" : "或粘贴配对数据"}
          </span>
        </div>
        <IonList inset>
          <IonItem>
            <IonIcon icon={lockClosedOutline} slot="start" />
            <IonTextarea
              label={language === "en" ? "Pairing data" : "配对数据"}
              labelPlacement="stacked"
              autoGrow
              rows={4}
              placeholder='{"service":"trylo-remote", ...}'
              value={pairingText}
              onIonInput={(event) =>
                setPairingText(String(event.detail.value || ""))
              }
            />
          </IonItem>
        </IonList>
        {error && (
          <p className="pairing-error">
            <IonIcon icon={alertCircleOutline} />
            {error}
          </p>
        )}
        <div className="modal-actions">
          <IonButton
            expand="block"
            disabled={!pairingText.trim()}
            onClick={connect}
          >
            <IonIcon slot="start" icon={radioOutline} />
            {language === "en"
              ? "Connect with pasted data"
              : "使用粘贴内容连接"}
          </IonButton>
          {!isDemo && (
            <IonButton
              expand="block"
              fill="clear"
              color="medium"
              onClick={onUseDemo}
            >
              {language === "en" ? "Unpair and use demo" : "解除配对并使用演示"}
            </IonButton>
          )}
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
  const releaseNotes =
    language === "en"
      ? [
          "Switch between dialogue and process views",
          "Compact approval sheets with one-time decisions",
          "Recover connections and preserve session drafts",
          "Desktop Code / Work sessions and project results",
        ]
      : [
          "对话与过程两种模式，记住阅读选择",
          "紧凑审批面板，明确单次授权范围",
          "恢复远程连接，保留各会话草稿",
          "Desktop Code / Work 会话与项目结果",
        ];
  return (
    <IonModal
      isOpen={open}
      onDidDismiss={onDismiss}
      initialBreakpoint={0.78}
      breakpoints={[0, 0.78, 1]}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>{language === "en" ? "Settings" : "设置"}</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onDismiss}>
              {language === "en" ? "Done" : "完成"}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="modal-content settings-content">
        <section className="language-setting-card">
          <div className="setting-card-icon">
            <IonIcon icon={languageOutline} />
          </div>
          <div className="language-setting-copy">
            <span className="eyebrow">LANGUAGE</span>
            <h3>{language === "en" ? "Interface language" : "界面语言"}</h3>
            <p>
              {language === "en"
                ? "Choose the language used by Trylo Code."
                : "选择 Trylo Code 的界面显示语言。"}
            </p>
          </div>
          <div
            className="language-options"
            role="group"
            aria-label="Interface language"
          >
            <button
              type="button"
              className={language === "zh" ? "active" : ""}
              onClick={() => onLanguageChange("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={language === "en" ? "active" : ""}
              onClick={() => onLanguageChange("en")}
            >
              English
            </button>
          </div>
        </section>
        <section className="font-setting-card">
          <div className="font-setting-heading">
            <div>
              <span className="eyebrow">READING</span>
              <h3>{language === "en" ? "Chat text size" : "对话字体大小"}</h3>
            </div>
            <strong>{Math.round(chatFontScale * 100)}%</strong>
          </div>
          <div className="font-setting-preview">
            {language === "en"
              ? "Preview text. Code blocks and tables scale with it."
              : "这是一段对话内容预览，代码和表格也会同步缩放。"}
          </div>
          <div className="font-setting-range">
            <span>{language === "en" ? "Small" : "小"}</span>
            <IonRange
              min={0.9}
              max={1.35}
              step={0.05}
              snaps
              value={chatFontScale}
              onIonInput={(event) =>
                onChatFontScaleChange(Number(event.detail.value))
              }
            />
            <span className="font-setting-large">
              {language === "en" ? "Large" : "大"}
            </span>
          </div>
          <div className="font-setting-presets">
            {[
              { label: language === "en" ? "Compact" : "紧凑", value: 0.95 },
              { label: language === "en" ? "Default" : "标准", value: 1.1 },
              { label: language === "en" ? "Comfort" : "舒适", value: 1.25 },
              { label: language === "en" ? "Large" : "大字", value: 1.35 },
            ].map((item) => (
              <button
                type="button"
                className={
                  Math.abs(chatFontScale - item.value) < 0.01 ? "active" : ""
                }
                key={item.label}
                onClick={() => onChatFontScaleChange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
        <section className="release-card">
          <div className="release-card__topline">
            <div>
              <span className="eyebrow">TRYLO CODE</span>
              <h3>
                {uiText(language, "版本", "Version")} {APP_VERSION}
              </h3>
            </div>
          </div>
          <p>{language === "en" ? "What's new" : "本次更新"}</p>
          <ul>
            {releaseNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      </IonContent>
    </IonModal>
  );
}
export default App;
