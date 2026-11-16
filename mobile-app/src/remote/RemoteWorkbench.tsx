import { remoteText } from "./copy";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
} from "react";
import {
  gatewayClient as client,
  type RemoteSnapshot,
  type GatewayConnectionState,
  type RemoteChatMessage,
  type RemoteArtifact,
} from "../gateway";
import { Icon, Mark } from "./icons";
import InlineProcess from "./InlineProcess";
import Home from "./Home";
import Collaboration from "./Collaboration";
import {
  AttachmentStrip,
  MarkdownMessage,
  formatBytes,
  formatRecentTime,
  type UiLanguage,
} from "../ui";
import {
  buildAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type DirectAttachment,
} from "../directChat";
import "./workbench.css";
type View = "home" | "sessions" | "conversation" | "inbox" | "devices";
type Pane = "chat" | "activity" | "results" | "team";
type DisplayMode = "dialogue" | "process";
const MODE_KEY = "trylo.remote.displayMode.v1";
function readMode(): DisplayMode {
  try {
    return localStorage.getItem(MODE_KEY) === "process"
      ? "process"
      : "dialogue";
  } catch {
    return "dialogue";
  }
}
type Sheet =
  | {
      kind: "approval";
      id: string;
    }
  | {
      kind: "device" | "new" | "stop" | "team";
    }
  | {
      kind: "tool";
      message: RemoteChatMessage;
    };
export interface RemoteWorkbenchProps {
  hidden?: boolean;
  navigation?: { id: number; tab: "home" | "runs" | "chat" | "approvals" };
  snapshot: RemoteSnapshot;
  messages: RemoteChatMessage[];
  state: GatewayConnectionState;
  artifacts: RemoteArtifact[];
  artifactsLoading: boolean;
  artifactError: string;
  onRefreshArtifacts: () => void;
  language: UiLanguage;
  demo: boolean;
  cachedAt: number | null;
  onReconnect: () => void;
  onPair: () => void;
  onSettings: () => void;
  onDirect: () => void;
  onProjects: () => void;
  onSession: (id: string) => Promise<boolean>;
  onCreate: (surface: "code" | "work") => Promise<boolean>;
  onOpenArtifact: (id: string) => void;
}
const statusOf = (snapshot: RemoteSnapshot | null) =>
  !snapshot
    ? "等待同步"
    : snapshot.approvals.length
      ? "需要确认"
      : snapshot.agent.phase === "stopped"
        ? "已停止"
        : snapshot.agent.status === "done"
          ? "已完成"
          : snapshot.agent.status === "failed"
            ? "执行失败"
            : snapshot.agent.status === "idle"
              ? "就绪"
              : "进行中";
const activeTool = (m: RemoteChatMessage) =>
  m.role === "thinking" || m.role === "tool";
const toolTarget = (message: RemoteChatMessage) => {
  try {
    const input = JSON.parse(message.input || "{}");
    return String(input.path || input.file_path || input.command || "");
  } catch {
    return message.input || "";
  }
};
const toolState = (message: RemoteChatMessage) =>
  message.status === "streaming"
    ? "进行中"
    : message.status === "interrupted"
      ? "已中断"
      : message.status === "error"
        ? "失败"
        : "已完成";
function SheetPanel({
  title,
  children,
  onClose,
  footer,
  language,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  language: UiLanguage;
}) {
  const t = (value: string) => remoteText(language, value);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    node.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (!node.contains(document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const focusable = [
          ...node.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], textarea:not(:disabled), [tabindex="0"]',
          ),
        ];
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="rw-sheet-layer">
      <button
        className="rw-scrim"
        onClick={onClose}
        aria-label={t("关闭面板")}
        tabIndex={-1}
      />
      <div
        ref={ref}
        className="rw-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="rw-sheet-grip" />
        <header>
          <h2 id={id}>{title}</h2>
          <button className="rw-icon" aria-label={t("关闭")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="rw-sheet-content">{children}</div>
        {footer && <div className="rw-sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
export default function RemoteWorkbench({
  hidden = false,
  navigation,
  snapshot,
  messages,
  state,
  artifacts,
  artifactsLoading,
  artifactError,
  onRefreshArtifacts,
  language,
  demo,
  cachedAt,
  onReconnect: reconnect,
  onPair,
  onSettings,
  onDirect,
  onProjects,
  onSession,
  onCreate,
  onOpenArtifact,
}: RemoteWorkbenchProps) {
  const t = (value: string) => remoteText(language, value);
  const contextKey = `${snapshot.device.id}:${snapshot.activeProjectId}:${snapshot.activeSessionId || "pending"}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const ready = !demo && state === "connected";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef(false);
  const perform = async (operation: () => Promise<unknown>) => {
    if (!ready || mutation.current) return false;
    const operationContext = currentContext.current;
    mutation.current = true;
    setPending(true);
    setError("");
    try {
      return (await operation()) !== false;
    } catch (cause) {
      if (operationContext === currentContext.current)
        setError(
          cause instanceof Error ? cause.message : t("操作失败，请重试"),
        );
      return false;
    } finally {
      mutation.current = false;
      setPending(false);
    }
  };
  const [view, setView] = useState<View>("home");
  const [pane, setPane] = useState<Pane>("chat");
  const [displayMode, setDisplayMode] = useState<DisplayMode>(readMode);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>(
    {},
  );
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [filter, setFilter] = useState("all");
  const [teamProfiles, setTeamProfiles] = useState<Record<string, string>>({});
  const teamProfileId = teamProfiles[contextKey];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedTurn, setSelectedTurn] = useState<string | undefined>();
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Record<string, DirectAttachment[]>
  >({});
  const [processingFiles, setProcessingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [following, setFollowing] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const viewPositions = useRef<
    Record<
      string,
      {
        top: number;
        follow: boolean;
      }
    >
  >({});
  const session = snapshot?.sessions.find(
    (s) => s.id === snapshot.activeSessionId,
  );
  const sessionId = snapshot?.activeSessionId || "pending";
  const positionKey = `${contextKey}:${displayMode}:${pane}`;
  const draft = drafts[contextKey] || "";
  const attachments = attachmentDrafts[contextKey] || [];
  const conversation = messages;
  const approval =
    sheet?.kind === "approval"
      ? snapshot.approvals.find((item) => item.id === sheet.id)
      : snapshot.approvals[0];
  const label = t(statusOf(snapshot));
  const filteredSessions =
    snapshot?.sessions.filter(
      (s) =>
        filter === "all" ||
        (s.id === sessionId &&
          (filter === "waiting"
            ? !!approval
            : !["idle", "done", "failed"].includes(snapshot.agent.status) &&
              snapshot.agent.phase !== "stopped")),
    ) || [];
  const currentTurn = [...conversation].reverse().find((m) => m.turnId)?.turnId;
  const processes = conversation.filter(
    (m) =>
      activeTool(m) &&
      ((!selectedTurn && !currentTurn) ||
        m.turnId === (selectedTurn || currentTurn)),
  );
  const selectedTool =
    sheet?.kind === "tool"
      ? conversation.find((item) => item.id === sheet.message.id) ||
        sheet.message
      : null;
  const tools = processes.filter((m) => m.role === "tool");
  const busy =
    !!snapshot &&
    !["idle", "done", "failed"].includes(snapshot.agent.status) &&
    snapshot.agent.phase !== "stopped";
  const offlineText = demo
    ? t("尚未连接电脑，当前显示演示内容")
    : state === "offline"
      ? t("连接已断开")
      : state === "reconnecting"
        ? t("正在恢复连接")
        : t("正在同步会话");
  const connectionText = demo
    ? t("未配对")
    : ready
      ? t("已同步")
      : state === "offline"
        ? t("离线")
        : t("同步中");
  useEffect(() => {
    if (
      sheet?.kind === "approval" &&
      !snapshot.approvals.some((item) => item.id === sheet.id)
    )
      setSheet(null);
  }, [snapshot.approvals, sheet]);
  useLayoutEffect(() => {
    if (hidden || !feed.current) return;
    const position = viewPositions.current[positionKey];
    followRef.current = position?.follow ?? true;
    setFollowing(followRef.current);
    feed.current.scrollTop =
      position?.top ?? (pane === "chat" ? feed.current.scrollHeight : 0);
  }, [positionKey, view, hidden]);
  useEffect(() => {
    if (!hidden && followRef.current && feed.current && pane === "chat")
      feed.current.scrollTop = feed.current.scrollHeight;
  }, [conversation, following, pane, displayMode, hidden]);
  useEffect(() => {
    if (!navigation) return;
    rememberPosition();
    setSheet(null);
    setView(
      navigation.tab === "home"
        ? "home"
        : navigation.tab === "approvals"
          ? "inbox"
          : "conversation",
    );
    setPane(navigation.tab === "runs" ? "results" : "chat");
  }, [navigation?.id]);
  useEffect(() => {
    setSelectedTurn(undefined);
  }, [contextKey]);
  useEffect(() => {
    setSheet(null);
    setError("");
  }, [contextKey]);
  const addFiles = async (files: File[]) => {
    const key = contextKey;
    setProcessingFiles(true);
    setError("");
    try {
      const available = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
      if (files.length > available)
        throw new Error(
          language === "en"
            ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`
            : `每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`,
        );
      const added = await Promise.all(files.map(buildAttachment));
      setAttachmentDrafts((current) => ({
        ...current,
        [key]: [...(current[key] || []), ...added].slice(
          0,
          MAX_ATTACHMENTS_PER_MESSAGE,
        ),
      }));
    } catch (cause) {
      if (key === currentContext.current)
        setError(cause instanceof Error ? cause.message : t("无法读取附件"));
    } finally {
      setProcessingFiles(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const openSession = async (id: string) => {
    if (id === sessionId) {
      setView("conversation");
      setPane("chat");
      return;
    }
    rememberPosition();
    if (await perform(() => onSession(id))) {
      setView("conversation");
      setPane("chat");
    }
  };
  const create = async (surface: "code" | "work") => {
    if (await perform(() => onCreate(surface))) {
      setSheet(null);
      setView("conversation");
      setPane("chat");
    }
  };
  const send = async () => {
    if (
      (!draft.trim() && !attachments.length) ||
      snapshot.approvals.length ||
      processingFiles
    )
      return;
    const sent = draft;
    if (
      await perform(() =>
        client.sendChat(sent.trim(), attachments, {
          surface: session?.surface || "code",
          ...(teamProfileId ? { teamProfileId } : {}),
        }),
      )
    ) {
      setDrafts((current) => ({
        ...current,
        [contextKey]: current[contextKey] === sent ? "" : current[contextKey],
      }));
      setAttachmentDrafts((current) => ({ ...current, [contextKey]: [] }));
      if (contextKey === currentContext.current) {
        followRef.current = true;
        setFollowing(true);
      }
    }
  };
  const rememberPosition = () => {
    if (feed.current)
      viewPositions.current[positionKey] = {
        top: feed.current.scrollTop,
        follow: followRef.current,
      };
  };
  const changeMode = (mode: DisplayMode) => {
    rememberPosition();
    setDisplayMode(mode);
    setPane("chat");
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* Reading remains available without storage. */
    }
  };
  const reviewGroup = (messages: RemoteChatMessage[]) => {
    const groupTools = messages.filter((m) => m.role === "tool");
    const done = groupTools.filter((m) => m.status === "done").length;
    return (
      <button
        className="rw-process-summary"
        onClick={() => {
          rememberPosition();
          setSelectedTurn(messages[0]?.turnId);
          setPane("activity");
        }}
      >
        <span className="rw-process-mark">
          <Icon name="activity" size={17} />
        </span>
        <span>
          <strong>{t("查看执行过程")}</strong>
          <small>
            {groupTools.length
              ? language === "en"
                ? `${done} operations completed`
                : `${done} 项操作已完成`
              : t("查看思考摘要")}
            {groupTools.some((m) => m.status === "streaming")
              ? language === "en"
                ? `, ${groupTools.filter((m) => m.status === "streaming").length} pending`
                : `，${groupTools.filter((m) => m.status === "streaming").length} 项未完成`
              : ""}
          </small>
        </span>
        <Icon name="chevron" size={15} />
      </button>
    );
  };
  const thread: ReactNode[] = [];
  for (let i = 0; i < conversation.length; i++) {
    const message = conversation[i];
    const expansionKey = `${contextKey}:${message.id}`;
    if (activeTool(message)) {
      if (displayMode === "process") {
        thread.push(
          <InlineProcess
            key={expansionKey}
            language={language}
            message={message}
            open={!!expandedEvents[expansionKey]}
            onOpen={(open) =>
              setExpandedEvents((current) =>
                current[expansionKey] === open
                  ? current
                  : { ...current, [expansionKey]: open },
              )
            }
          />,
        );
        continue;
      }
      const group = [message];
      while (
        i + 1 < conversation.length &&
        activeTool(conversation[i + 1]) &&
        conversation[i + 1].turnId === message.turnId
      )
        group.push(conversation[++i]);
      thread.push(<div key={message.id}>{reviewGroup(group)}</div>);
    } else if (message.role === "user")
      thread.push(
        <div className="rw-user" key={message.id}>
          {message.attachments && (
            <AttachmentStrip
              attachments={message.attachments}
              language={language}
            />
          )}
          <MarkdownMessage text={message.text} language={language} />
        </div>,
      );
    else
      thread.push(
        <article className="rw-assistant" key={message.id}>
          <div className="rw-assistant-label">
            <Mark />
            <span>Trylo</span>
          </div>
          <MarkdownMessage text={message.text} language={language} />
        </article>,
      );
  }
  const nav = (
    <nav className="rw-navigation" aria-label={t("远程工作台导航")}>
      {(["home", "sessions", "inbox", "devices"] as const).map((item, i) => (
        <button
          key={item}
          aria-current={view === item ? "page" : undefined}
          onClick={() => {
            setView(item);
            setSheet(null);
          }}
        >
          <span>
            <Icon name={["home", "message", "inbox", "desktop"][i]} />
            {item === "inbox" && !demo && approval && <i />}
          </span>
          {
            [
              language === "en" ? "Home" : "首页",
              t("会话"),
              t("待处理"),
              t("设备"),
            ][i]
          }
        </button>
      ))}
    </nav>
  );
  return (
    <section className="remote-workbench" hidden={hidden}>
      <div className="rw-app">
        <div className="rw-app-content" inert={!!sheet}>
          {view === "conversation" ? (
            <>
              <header className="rw-conversation-header">
                <div className="rw-titlebar">
                  <button
                    className="rw-icon"
                    aria-label={t("返回会话列表")}
                    onClick={() => setView("sessions")}
                  >
                    <Icon name="back" />
                  </button>
                  <div>
                    <h1>{session?.title || t("远程会话")}</h1>
                    <span>
                      {session?.surface === "work" ? "Work" : "Code"} <i />{" "}
                      {snapshot.device.workspace}
                    </span>
                  </div>
                  <button
                    className="rw-icon"
                    aria-label={t("查看会话与设备")}
                    onClick={() => setSheet({ kind: "device" })}
                  >
                    <Icon name="more" />
                  </button>
                </div>
                <button
                  className={`rw-connection ${!ready ? "is-offline" : ""}`}
                  onClick={() => setSheet({ kind: "device" })}
                >
                  <Icon name="desktop" size={13} />
                  <span>{snapshot?.device.name || t("开发电脑")}</span>
                  <span>
                    <i />
                    {connectionText}
                  </span>
                  <Icon name="chevron" size={12} />
                </button>
              </header>
              {!ready && (
                <div className="rw-recovery" role="status">
                  <Icon name="retry" size={15} />
                  <span>
                    {offlineText}
                    {!demo && t("，已保留内容和草稿。")}
                  </span>
                  <button onClick={demo ? onPair : reconnect}>
                    {t(demo ? "连接电脑" : "重试")}
                  </button>
                </div>
              )}
              <div className="rw-viewbar">
                <div
                  className="rw-mode-switch"
                  role="group"
                  aria-label={t("事件流展示模式")}
                >
                  {(["dialogue", "process"] as const).map((mode) => (
                    <button
                      key={mode}
                      aria-pressed={displayMode === mode}
                      onClick={() => changeMode(mode)}
                    >
                      {mode === "dialogue" ? t("对话模式") : t("过程模式")}
                    </button>
                  ))}
                </div>
                <button
                  className={`rw-result-entry${pane === "results" ? " selected" : ""}`}
                  aria-pressed={pane === "results"}
                  onClick={() => {
                    rememberPosition();
                    setPane(pane === "results" ? "chat" : "results");
                  }}
                >
                  <Icon name="file" size={14} />
                  {t("结果")}
                  {artifacts.length > 0 && <small>{artifacts.length}</small>}
                </button>
                <button
                  className={`rw-result-entry${pane === "team" ? " selected" : ""}`}
                  aria-pressed={pane === "team"}
                  onClick={() => {
                    rememberPosition();
                    setPane(pane === "team" ? "chat" : "team");
                  }}
                >
                  <Icon name="team" size={16} />
                  {language === "en" ? "Team" : "成员"}
                  {!!snapshot.collaboration?.members.length && (
                    <small>{snapshot.collaboration.members.length}</small>
                  )}
                </button>
              </div>
              <div
                className={`rw-feed rw-feed-${pane} rw-mode-${displayMode}`}
                role="region"
                aria-label={
                  pane === "team"
                    ? language === "en"
                      ? "Team and subagents"
                      : "团队与子智能体"
                    : pane === "chat"
                      ? displayMode === "process"
                        ? t("完整事件流")
                        : t("对话内容")
                      : pane === "activity"
                        ? t("执行记录")
                        : t("项目结果")
                }
                ref={feed}
                onScroll={() => {
                  const e = feed.current;
                  if (e) {
                    const follow =
                      e.scrollHeight - e.scrollTop - e.clientHeight < 70;
                    followRef.current = follow;
                    setFollowing(follow);
                    viewPositions.current[positionKey] = {
                      top: e.scrollTop,
                      follow,
                    };
                  }
                }}
              >
                {pane === "team" && (
                  <Collaboration
                    key={contextKey}
                    data={snapshot.collaboration}
                    language={language}
                  />
                )}
                {pane === "chat" && (
                  <>
                    {conversation.length ? (
                      <>
                        <div className="rw-day">
                          {demo ? t("演示会话") : t("电脑端会话")}
                          {cachedAt ? t(" · 离线缓存") : ""}
                        </div>
                        {thread}
                      </>
                    ) : (
                      <div className="rw-empty">
                        <Mark />
                        <h2>{t("从这里继续工作")}</h2>
                        <p>
                          {t("消息会发送到电脑，过程和结果同步到这段会话。")}
                        </p>
                      </div>
                    )}
                    {snapshot?.agent.status === "done" && (
                      <div className="rw-finish">
                        <Icon name="check" size={14} />
                        {t("任务已完成")}
                      </div>
                    )}
                    {snapshot?.agent.phase === "stopped" && (
                      <div className="rw-finish">
                        <Icon name="stop" size={14} />
                        {t("电脑已停止本次任务")}
                      </div>
                    )}
                  </>
                )}
                {pane === "activity" && (
                  <>
                    <button
                      className="rw-back-to-thread"
                      onClick={() => {
                        rememberPosition();
                        setPane("chat");
                      }}
                    >
                      <Icon name="back" size={14} />
                      {t("返回对话")}
                    </button>
                    <div className="rw-section-head">
                      <h2>{t("执行记录")}</h2>
                      <span>
                        {tools.filter((m) => m.status === "done").length} /{" "}
                        {tools.length}
                        {t("项完成")}
                      </span>
                    </div>
                    <p className="rw-description">
                      {t("由电脑同步的思考摘要与工具操作。")}
                    </p>
                    <div className="rw-log-list">
                      {processes.map((message) => (
                        <button
                          className="rw-log"
                          key={message.id}
                          onClick={() => setSheet({ kind: "tool", message })}
                        >
                          <span
                            className={`rw-log-symbol ${message.status === "streaming" ? "waiting" : ""}`}
                          >
                            <Icon
                              name={
                                message.role === "thinking"
                                  ? "activity"
                                  : message.status === "streaming"
                                    ? "clock"
                                    : "check"
                              }
                              size={17}
                            />
                          </span>
                          <span>
                            <strong>{message.title || t("思考摘要")}</strong>
                            <small>
                              {message.role === "thinking"
                                ? t("思考摘要")
                                : toolTarget(message)}
                            </small>
                            <em
                              className={
                                message.status === "streaming" ? "waiting" : ""
                              }
                            >
                              {message.role === "thinking"
                                ? t("展开查看")
                                : t(toolState(message))}
                              {message.durationMs != null
                                ? ` · ${(message.durationMs / 1000).toFixed(2)} 秒`
                                : ""}
                            </em>
                          </span>
                          <Icon name="chevron" size={15} />
                        </button>
                      ))}
                    </div>
                    {!processes.length && (
                      <div className="rw-empty">
                        <Icon name="activity" size={32} />
                        <h2>{t("还没有执行记录")}</h2>
                        <p>{t("任务开始后，电脑的执行过程会显示在这里。")}</p>
                      </div>
                    )}
                  </>
                )}
                {pane === "results" && (
                  <>
                    <div className="rw-section-head">
                      <h2>{t("项目文件")}</h2>
                      <span>
                        {artifacts.length}{" "}
                        {language === "en" ? "files" : t("个文件")}
                      </span>
                      <button
                        className="rw-text-button"
                        disabled={!ready || artifactsLoading}
                        onClick={onRefreshArtifacts}
                      >
                        {t("刷新结果")}
                      </button>
                    </div>
                    {artifactsLoading && (
                      <p role="status">{t("正在读取项目文件…")}</p>
                    )}
                    {artifactError && (
                      <p className="rw-error" role="alert">
                        {artifactError}
                      </p>
                    )}
                    <p className="rw-description">
                      {t("查看电脑在当前项目中生成的结果。")}
                    </p>
                    {artifacts.map((file) => (
                      <button
                        className="rw-file"
                        key={file.id}
                        disabled={!ready || pending}
                        onClick={() => onOpenArtifact(file.id)}
                      >
                        <span>
                          <Icon name="file" size={23} />
                        </span>
                        <span>
                          <strong>{file.name}</strong>
                          <small>
                            {file.kind} · {formatBytes(file.size)}
                          </small>
                        </span>
                        <Icon name="chevron" size={16} />
                      </button>
                    ))}
                    {!artifacts.length &&
                      !artifactsLoading &&
                      !artifactError && (
                        <div className="rw-empty">
                          <Icon name="file" size={34} />
                          <h2>{t("结果会留在这里")}</h2>
                          <p>
                            {approval
                              ? t(
                                  "处理当前确认后，电脑会继续执行并整理检查记录。",
                                )
                              : t("电脑生成的文件将显示在这里。")}
                          </p>
                        </div>
                      )}
                  </>
                )}
              </div>
              {pane === "chat" && !following && (
                <button
                  className="rw-jump"
                  onClick={() => {
                    followRef.current = true;
                    setFollowing(true);
                  }}
                >
                  {t("回到最新消息")}
                  <Icon name="down" size={13} />
                </button>
              )}
              <div className="rw-conversation-bottom">
                {approval ? (
                  <button
                    className="rw-attention"
                    onClick={() =>
                      setSheet({ kind: "approval", id: approval!.id })
                    }
                  >
                    <Icon name="shield" size={18} />
                    <span>
                      <strong>{t("需要你确认")}</strong>
                      <small>{approval.title}</small>
                    </span>
                    <b>{t("查看")}</b>
                    <Icon name="chevron" size={14} />
                  </button>
                ) : (
                  <div className="rw-run-line">
                    <span>
                      <i className={ready ? "online" : ""} />
                      {ready ? label : t("等待恢复同步")}
                    </span>
                    {busy && (
                      <button
                        disabled={!ready || pending}
                        onClick={() => setSheet({ kind: "stop" })}
                      >
                        <Icon name="stop" size={13} />
                        {t("停止")}
                      </button>
                    )}
                  </div>
                )}
                {error && (
                  <p className="rw-error" role="alert">
                    {error}
                  </p>
                )}
                {pane === "chat" && (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.py,.log,.html,.css,.xml,.yaml,.yml"
                      onChange={(e) =>
                        void addFiles(Array.from(e.target.files || []))
                      }
                    />
                    {attachments.length > 0 && (
                      <div className="remote-attachments">
                        {attachments.map((file) => (
                          <span key={file.id}>
                            {file.name}
                            <button
                              type="button"
                              aria-label={
                                language === "en"
                                  ? `Remove ${file.name}`
                                  : `移除 ${file.name}`
                              }
                              onClick={() =>
                                setAttachmentDrafts((current) => ({
                                  ...current,
                                  [contextKey]: (
                                    current[contextKey] || []
                                  ).filter((item) => item.id !== file.id),
                                }))
                              }
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <form
                      className="rw-composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send();
                      }}
                    >
                      <textarea
                        rows={2}
                        aria-label={t("发送到电脑的消息")}
                        placeholder={
                          ready
                            ? t("让电脑继续做点什么…")
                            : t("连接恢复后继续，草稿会保留")
                        }
                        value={draft}
                        onChange={(e) =>
                          setDrafts((current) => ({
                            ...current,
                            [contextKey]: e.target.value,
                          }))
                        }
                      />
                      <div>
                        <span>
                          <button
                            type="button"
                            className="remote-attach"
                            aria-label={t("添加附件")}
                            disabled={pending || processingFiles}
                            onClick={() => fileInput.current?.click()}
                          >
                            <Icon name="add" size={16} />
                          </button>
                          <Icon name="desktop" size={12} />
                          {session?.surface === "work" ? "Work" : "Code"}
                          <button
                            type="button"
                            className="rw-collaboration-select"
                            aria-label={
                              language === "en"
                                ? "Choose collaboration mode"
                                : "选择协作方式"
                            }
                            onClick={() => setSheet({ kind: "team" })}
                          >
                            <Icon
                              name={teamProfileId ? "team" : "message"}
                              size={14}
                            />
                            {teamProfileId
                              ? language === "en"
                                ? "Team"
                                : "团队协作"
                              : language === "en"
                                ? "Solo"
                                : "单人"}
                            <Icon name="down" size={11} />
                          </button>
                        </span>
                        <button
                          aria-label={t("发送消息")}
                          className="rw-send"
                          disabled={
                            !ready ||
                            pending ||
                            (!draft.trim() && !attachments.length) ||
                            processingFiles ||
                            !!approval
                          }
                        >
                          <Icon name="arrow" size={19} />
                        </button>
                      </div>
                    </form>
                  </>
                )}
                <div className="rw-safe-area" />
              </div>
            </>
          ) : (
            <>
              <header className="rw-home-header">
                <div className="rw-brand">
                  <Mark />
                  <span>Trylo</span>
                  <span className="rw-remote-label">
                    {language === "en" ? "Your workspace" : "随时接着做"}
                  </span>
                </div>
                <button
                  className="rw-icon"
                  aria-label={view === "home" ? t("设置") : t("新建远程会话")}
                  disabled={view !== "home" && (!ready || pending)}
                  onClick={() =>
                    view === "home" ? onSettings() : setSheet({ kind: "new" })
                  }
                >
                  <Icon name={view === "home" ? "settings" : "add"} size={23} />
                </button>
              </header>
              <div className="rw-home-scroll">
                {(view === "home" || (demo && view === "sessions")) && (
                  <Home
                    snapshot={snapshot}
                    demo={demo}
                    ready={ready}
                    language={language}
                    onDirect={onDirect}
                    onPair={onPair}
                    onSessions={() => setView("sessions")}
                    onSession={(id) => void openSession(id)}
                    onInbox={() => setView("inbox")}
                    onDemo={() => setView("conversation")}
                  />
                )}
                {view === "sessions" && !demo && (
                  <>
                    <div className="rw-home-title">
                      <h1>{t("会话")}</h1>
                      <button
                        onClick={() => setView("devices")}
                        className={`rw-home-connection ${!ready ? "offline" : ""}`}
                      >
                        <i />
                        {ready ? t("电脑在线") : connectionText}
                        <Icon name="chevron" size={12} />
                      </button>
                    </div>
                    <button
                      className="rw-workspace"
                      disabled={!ready || pending}
                      onClick={onProjects}
                    >
                      <span className="rw-workspace-icon">
                        <Icon name="folder" size={20} />
                      </span>
                      <span>
                        <strong>{snapshot.device.workspace}</strong>
                        <small>{snapshot?.device.name || t("开发电脑")}</small>
                      </span>
                      <Icon name="chevron" size={16} />
                    </button>
                    {!!approval && (
                      <button
                        className="rw-home-attention"
                        onClick={() => setView("inbox")}
                      >
                        <span className="rw-attention-icon">
                          <Icon name="inbox" size={19} />
                        </span>
                        <span>
                          <strong>
                            {language === "en"
                              ? `${snapshot.approvals.length} actions need your review`
                              : `有 ${snapshot.approvals.length} 项操作需要你确认`}
                          </strong>
                          <small>{t("处理后，电脑会继续当前任务")}</small>
                        </span>
                        <Icon name="chevron" size={16} />
                      </button>
                    )}
                    <div
                      className="rw-filter"
                      role="group"
                      aria-label={t("筛选会话")}
                    >
                      {[
                        ["all", t("全部")],
                        ["active", t("进行中")],
                        ["waiting", t("待处理")],
                      ].map(([key, title]) => (
                        <button
                          key={key}
                          aria-pressed={filter === key}
                          onClick={() => setFilter(key)}
                        >
                          {title}
                          {key === "waiting" && approval && (
                            <small>{snapshot.approvals.length}</small>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="rw-session-list">
                      {filteredSessions.map((s) => (
                        <button
                          className="rw-session"
                          key={s.id}
                          disabled={(!ready && s.id !== sessionId) || pending}
                          onClick={() => void openSession(s.id)}
                        >
                          <div className="rw-session-line">
                            <span className="rw-surface">
                              {s.surface === "work" ? "Work" : "Code"}
                            </span>
                            {s.id === sessionId && (
                              <span
                                className={`rw-session-status ${approval ? "waiting" : ""}`}
                              >
                                {label}
                              </span>
                            )}
                            <time>
                              {formatRecentTime(s.updatedAt, language)}
                            </time>
                          </div>
                          <h2>{s.title}</h2>
                          <p>
                            {s.id === sessionId && approval
                              ? language === "en"
                                ? `Awaiting approval: ${approval.title}`
                                : `等待确认：${approval.title}`
                              : s.preview || t("开始一段新的远程对话")}
                          </p>
                          <div className="rw-session-meta">
                            <Icon name="folder" size={12} />
                            {s.workspace?.name || snapshot.device.workspace}
                            {s.id === sessionId && <span>{t("当前会话")}</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                    {!filteredSessions.length && (
                      <div className="rw-empty">
                        <Icon name="check" size={29} />
                        <h2>
                          {filter === "waiting"
                            ? t("没有等待确认的会话")
                            : filter === "active"
                              ? t("暂时没有进行中的会话")
                              : t("还没有远程会话")}
                        </h2>
                        <p>{t("可以开始一段新的对话，或查看全部会话。")}</p>
                        <button
                          className="rw-text-button"
                          onClick={() => setFilter("all")}
                        >
                          {t("查看全部会话")}
                        </button>
                      </div>
                    )}
                    <p className="rw-list-hint">
                      {t("会话与电脑保持同步，随时接着工作。")}
                    </p>
                  </>
                )}
                {view === "inbox" && (
                  <>
                    <div className="rw-home-title">
                      <h1>{t("待处理")}</h1>
                      <span className="rw-count">
                        {demo ? 0 : snapshot.approvals.length}
                      </span>
                    </div>
                    <p className="rw-description">
                      {t("需要你确认后才能继续的操作。")}
                    </p>
                    {!demo && snapshot.approvals.length ? (
                      snapshot.approvals.map((item) => (
                        <button
                          key={item.id}
                          className="rw-inbox-item"
                          onClick={() =>
                            setSheet({ kind: "approval", id: item.id })
                          }
                        >
                          <div>
                            <Icon name="shield" size={20} />
                            <span>{t("等待确认")}</span>
                          </div>
                          <h2>{item.title}</h2>
                          <p>{session?.title}</p>
                          <code>{item.detail}</code>
                          <span className="rw-inbox-action">
                            {t("查看操作")}
                            <Icon name="chevron" size={15} />
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="rw-empty">
                        <Icon name="check" size={34} />
                        <h2>{t("暂时没有待处理事项")}</h2>
                        <p>{t("电脑需要你确认时，会在这里显示。")}</p>
                        <button
                          className="rw-text-button"
                          onClick={() => setView("sessions")}
                        >
                          {t("返回会话")}
                        </button>
                      </div>
                    )}
                  </>
                )}
                {view === "devices" && (
                  <>
                    <div className="rw-home-title">
                      <h1>{t("设备")}</h1>
                    </div>
                    <div className="rw-device-profile">
                      <span>
                        <Icon name="desktop" size={32} />
                      </span>
                      <h2>{snapshot?.device.name || t("开发电脑")}</h2>
                      <p>
                        <i className={ready ? "online" : ""} />
                        {ready ? t("连接正常，会话已同步") : offlineText}
                      </p>
                    </div>
                    <dl className="rw-facts">
                      <div>
                        <dt>{t("当前项目")}</dt>
                        <dd>{snapshot.device.workspace}</dd>
                      </div>
                      <div>
                        <dt>{t("当前会话")}</dt>
                        <dd>{session?.title || t("新会话")}</dd>
                      </div>
                      <div>
                        <dt>{t("最近同步")}</dt>
                        <dd>
                          {snapshot.device.lastSeenAt
                            ? new Date(
                                snapshot.device.lastSeenAt,
                              ).toLocaleTimeString(
                                language === "en" ? "en-US" : "zh-CN",
                              )
                            : t("等待连接")}
                        </dd>
                      </div>
                    </dl>
                    <button
                      className="rw-settings-row"
                      onClick={() => reconnect()}
                    >
                      <Icon name="retry" size={19} />
                      {t("重新连接")}
                      <Icon name="chevron" size={16} />
                    </button>
                    <button className="rw-settings-row" onClick={onPair}>
                      <Icon name="link" size={19} />
                      {t("扫码连接电脑")}
                      <Icon name="chevron" size={16} />
                    </button>
                    <button
                      className="rw-settings-row"
                      disabled={!ready || pending}
                      onClick={onProjects}
                    >
                      <Icon name="folder" size={19} />
                      {t("切换项目")}
                      <Icon name="chevron" size={16} />
                    </button>
                    <button className="rw-settings-row" onClick={onSettings}>
                      <Icon name="more" size={19} />
                      {t("设置")}
                      <Icon name="chevron" size={16} />
                    </button>
                    <button
                      className="rw-settings-row"
                      disabled={pending}
                      onClick={onDirect}
                    >
                      <Icon name="message" size={19} />
                      {t("手机直连聊天")}
                      <Icon name="chevron" size={16} />
                    </button>
                    <p className="rw-list-hint">
                      {t(
                        "工作在电脑上运行。电脑需要保持开启，并允许远程连接。",
                      )}
                    </p>
                  </>
                )}
              </div>
              {nav}
            </>
          )}
        </div>
        {sheet && (
          <SheetPanel
            key={sheet.kind}
            language={language}
            title={
              sheet.kind === "team"
                ? language === "en"
                  ? "Collaboration"
                  : "选择协作方式"
                : sheet.kind === "approval"
                  ? t("确认电脑上的操作")
                  : sheet.kind === "tool"
                    ? sheet.message.title || t("执行详情")
                    : sheet.kind === "new"
                      ? t("新建会话")
                      : sheet.kind === "stop"
                        ? t("停止当前任务？")
                        : t("会话与设备")
            }
            onClose={() => setSheet(null)}
            footer={
              sheet.kind === "approval" ? (
                <>
                  <p className="rw-scope">
                    <Icon name="shield" size={13} />
                    {t("仅允许这一次操作")}
                  </p>
                  <div className="rw-action-pair">
                    <button
                      disabled={!ready || pending || !approval}
                      onClick={() =>
                        void perform(() =>
                          client.decidePermission(approval!.id, "deny"),
                        )
                      }
                    >
                      {t("拒绝")}
                    </button>
                    <button
                      className="primary"
                      disabled={!ready || pending || !approval}
                      onClick={() =>
                        void perform(() =>
                          client.decidePermission(approval!.id, "allow"),
                        )
                      }
                    >
                      {pending ? t("正在提交…") : t("允许本次")}
                    </button>
                  </div>
                  {!ready && (
                    <p className="rw-sheet-offline">
                      {t("连接恢复并同步后才能确认。")}
                    </p>
                  )}
                </>
              ) : sheet.kind === "stop" ? (
                <div className="rw-action-pair">
                  <button onClick={() => setSheet(null)}>
                    {t("继续任务")}
                  </button>
                  <button
                    className="danger"
                    disabled={!ready || pending}
                    onClick={() =>
                      void perform(() => client.cancelCurrentTask()).then(
                        (ok) => {
                          if (ok && contextKey === currentContext.current)
                            setSheet(null);
                        },
                      )
                    }
                  >
                    {pending ? t("正在请求…") : t("停止任务")}
                  </button>
                </div>
              ) : undefined
            }
          >
            {sheet.kind === "team" && (
              <div className="rw-team-picker">
                <p className="rw-description">
                  {language === "en"
                    ? "Choose how to handle your next message. Work runs on your computer."
                    : "选择下一条消息的协作方式，任务会在电脑上执行。"}
                </p>
                <button
                  className="rw-profile-option"
                  aria-pressed={!teamProfileId}
                  onClick={() => {
                    setTeamProfiles((current) => ({
                      ...current,
                      [contextKey]: "",
                    }));
                    setSheet(null);
                  }}
                >
                  <Icon name="message" />
                  <span>
                    <strong>{language === "en" ? "Solo" : "单人"}</strong>
                    <small>
                      {language === "en"
                        ? "Let the main agent handle your request"
                        : "由主智能体处理，需要时委派子任务"}
                    </small>
                  </span>
                  {!teamProfileId && <Icon name="check" size={18} />}
                </button>
                {snapshot.collaboration?.canStartTeam ? (
                  snapshot.collaboration.profiles.map((profile) => (
                    <button
                      key={profile.id}
                      className="rw-profile-option"
                      aria-pressed={profile.id === teamProfileId}
                      onClick={() => {
                        setTeamProfiles((current) => ({
                          ...current,
                          [contextKey]: profile.id,
                        }));
                        setSheet(null);
                      }}
                    >
                      <Icon name="team" />
                      <span>
                        <strong>{profile.title}</strong>
                        <small>{profile.members.join(" · ")}</small>
                      </span>
                      {profile.id === teamProfileId && (
                        <Icon name="check" size={18} />
                      )}
                    </button>
                  ))
                ) : (
                  <p className="rw-description">
                    {language === "en"
                      ? "Update Desktop to a version that supports mobile teams and enable Team Access. Members appear here when they join."
                      : "请更新到支持手机团队的配套电脑版，并开启团队协作。成员开始参与后会出现在「成员」。"}
                  </p>
                )}
              </div>
            )}
            {sheet.kind === "approval" && (
              <>
                <div className="rw-approval-context">
                  <span className="rw-large-icon">
                    <Icon name="terminal" size={23} />
                  </span>
                  <div>
                    <strong>{approval?.title || t("操作已处理")}</strong>
                    <small>
                      {snapshot.device.name} / {snapshot.device.workspace}
                    </small>
                  </div>
                </div>
                <p className="rw-sheet-explanation">
                  {t(
                    "电脑正在等待你确认。允许后，这项操作会在当前项目继续执行。",
                  )}
                </p>
                <div className="rw-command">
                  <label>
                    {approval?.category === "command"
                      ? t("命令")
                      : approval?.category === "network"
                        ? t("网络访问")
                        : t("文件操作")}
                  </label>
                  <code>
                    {approval?.detail ||
                      approval?.blockedPath ||
                      t("电脑未提供额外内容")}
                  </code>
                  <span>
                    {t("项目")}
                    <b>{snapshot.device.workspace}</b>
                  </span>
                  {approval?.blockedPath && (
                    <span>
                      {t("目标")}
                      <b>{approval.blockedPath}</b>
                    </span>
                  )}
                  {approval?.toolName && (
                    <span>
                      {t("工具")}
                      <b>{approval.toolName}</b>
                    </span>
                  )}
                </div>
                <details className="rw-reason">
                  <summary>{t("为什么需要确认")}</summary>
                  <p>
                    {approval?.description ||
                      approval?.decisionReason ||
                      t(
                        "此决定只应用于当前操作，后续操作仍按电脑端权限策略处理。",
                      )}
                  </p>
                </details>
                {error && (
                  <p className="rw-error" role="alert">
                    {error}
                  </p>
                )}
              </>
            )}
            {sheet.kind === "tool" && (
              <>
                <div className="rw-tool-state">
                  <Icon
                    name={
                      selectedTool!.status === "streaming" ? "clock" : "check"
                    }
                    size={16}
                  />
                  {selectedTool!.role === "thinking"
                    ? t("思考摘要")
                    : t(toolState(selectedTool!))}
                </div>
                {selectedTool!.role === "thinking" ? (
                  <p className="rw-sheet-explanation">{selectedTool!.text}</p>
                ) : (
                  <>
                    {selectedTool!.input && (
                      <>
                        <h3>{t("输入")}</h3>
                        <pre>
                          {(() => {
                            try {
                              return JSON.stringify(
                                JSON.parse(selectedTool!.input!),
                                null,
                                2,
                              );
                            } catch {
                              return selectedTool!.input;
                            }
                          })()}
                        </pre>
                      </>
                    )}
                    {selectedTool!.output !== undefined ? (
                      <>
                        <h3>{t("结果")}</h3>
                        <pre>{selectedTool!.output || t("无文本输出")}</pre>
                      </>
                    ) : (
                      <p className="rw-sheet-explanation">
                        {selectedTool!.status === "streaming"
                          ? t("电脑尚未返回结果。")
                          : t("电脑未提供文本结果。")}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {sheet.kind === "device" && (
              <>
                <div className="rw-sheet-computer">
                  <Icon name="desktop" size={29} />
                  <span>
                    <strong>{snapshot?.device.name || t("开发电脑")}</strong>
                    <small>{ready ? t("当前会话已同步") : offlineText}</small>
                  </span>
                  <i className={ready ? "online" : ""} />
                </div>
                <dl className="rw-facts">
                  <div>
                    <dt>{t("项目")}</dt>
                    <dd>{snapshot.device.workspace}</dd>
                  </div>
                  <div>
                    <dt>{t("会话")}</dt>
                    <dd>{session?.title || t("新会话")}</dd>
                  </div>
                  <div>
                    <dt>{t("执行通道")}</dt>
                    <dd>{session?.surface === "work" ? "Work" : "Code"}</dd>
                  </div>
                </dl>
                <button
                  className="rw-settings-row"
                  onClick={() => {
                    reconnect();
                    setSheet(null);
                  }}
                >
                  <Icon name="retry" size={18} />
                  {t("重新同步")}
                  <Icon name="chevron" size={15} />
                </button>
                {busy && (
                  <button
                    className="rw-settings-row"
                    disabled={!ready || pending}
                    onClick={() => setSheet({ kind: "stop" })}
                  >
                    <Icon name="stop" size={18} />
                    {t("停止任务")}
                    <Icon name="chevron" size={15} />
                  </button>
                )}
              </>
            )}
            {sheet.kind === "new" && (
              <>
                <p className="rw-sheet-explanation">
                  {t("选择要在电脑上开始的工作。")}
                </p>
                <button
                  className="rw-new-choice"
                  disabled={!ready || pending}
                  onClick={() => void create("code")}
                >
                  <Icon name="terminal" />
                  <span>
                    <strong>Code</strong>
                    <small>{t("编写代码、调试与项目开发")}</small>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
                <button
                  className="rw-new-choice"
                  disabled={!ready || pending}
                  onClick={() => void create("work")}
                >
                  <Icon name="file" />
                  <span>
                    <strong>Work</strong>
                    <small>{t("资料整理、文档和日常工作")}</small>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              </>
            )}
            {sheet.kind === "stop" && (
              <p className="rw-sheet-explanation">
                {t("将请求电脑停止当前任务。已经收到的内容和执行记录会保留。")}
              </p>
            )}
            {error && sheet.kind !== "approval" && (
              <p className="rw-error" role="alert">
                {error}
              </p>
            )}
          </SheetPanel>
        )}
      </div>
    </section>
  );
}
