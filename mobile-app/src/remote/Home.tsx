import type { RemoteSnapshot } from "../gateway";
import type { UiLanguage } from "../ui";
import { Icon } from "./icons";

export default function Home({
  snapshot,
  demo,
  ready,
  language,
  onDirect,
  onPair,
  onSessions,
  onSession,
  onInbox,
  onDemo,
}: {
  snapshot: RemoteSnapshot;
  demo: boolean;
  ready: boolean;
  language: UiLanguage;
  onDirect: () => void;
  onPair: () => void;
  onSessions: () => void;
  onInbox: () => void;
  onDemo: () => void;
  onSession: (id: string) => void;
}) {
  const t = (zh: string, en: string) => (language === "en" ? en : zh);
  return (
    <div className="rw-start">
      <div className="rw-start-heading">
        <h1>{t("从这里开始", "What would you like to do?")}</h1>
        <p>
          {t(
            "随手聊一个想法，或接着电脑上的任务。",
            "Talk through an idea, or pick up work from your computer.",
          )}
        </p>
      </div>
      <button className="rw-start-chat" onClick={onDirect}>
        <Icon name="message" size={25} />
        <span>
          <strong>{t("在手机上聊聊", "Chat on your phone")}</strong>
          <small>
            {t(
              "写作、问答、整理想法，无需连接电脑",
              "Write, ask questions, and explore ideas. No computer needed.",
            )}
          </small>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <section className="rw-computer-start">
        <div className="rw-start-section-title">
          <Icon name="desktop" size={21} />
          <h2>{t("电脑工作台", "Your computer workspace")}</h2>
        </div>
        <p>
          {demo
            ? t(
                "让电脑执行任务，在手机上查看进度、确认操作和接收结果。",
                "Let your computer do the work. Follow progress, review actions, and read results here.",
              )
            : snapshot.device.name}
        </p>
        {demo ? (
          <>
            <button className="rw-primary" onClick={onPair}>
              <Icon name="link" size={18} />
              {t("连接我的电脑", "Connect my computer")}
            </button>
            <p className="rw-setup-hint">
              {t(
                "在电脑版打开「手机扫码配对」，扫描配对码即可。",
                "On Desktop, open Phone pairing and scan the pairing code.",
              )}
            </p>
          </>
        ) : (
          <>
            <div className="rw-start-status">
              <i className={ready ? "online" : ""} />
              {ready
                ? t(
                    "已连接 · 会话保持同步",
                    "Connected · Conversations are synced",
                  )
                : t(
                    "当前离线，仍可查看已同步的内容",
                    "Offline · Synced conversations are still available",
                  )}
            </div>
            {snapshot.approvals.length > 0 && (
              <button className="rw-start-review" onClick={onInbox}>
                <Icon name="inbox" />
                <span>
                  {t(
                    `${snapshot.approvals.length} 项操作等你确认`,
                    `${snapshot.approvals.length} actions need your review`,
                  )}
                </span>
                <Icon name="chevron" size={17} />
              </button>
            )}
            <button className="rw-primary" onClick={onSessions}>
              {t("继续电脑上的会话", "Continue a conversation")}
              <Icon name="chevron" size={18} />
            </button>
          </>
        )}
      </section>
      {!demo && snapshot.sessions.length > 0 && (
        <section className="rw-home-recent">
          <div className="rw-start-section-title">
            <h2>{t("最近的会话", "Recent conversations")}</h2>
            <button className="rw-text-button" onClick={onSessions}>
              {t("全部", "See all")}
            </button>
          </div>
          {snapshot.sessions.slice(0, 3).map((session) => (
            <button
              key={session.id}
              disabled={!ready && session.id !== snapshot.activeSessionId}
              className="rw-recent-row"
              onClick={() => onSession(session.id)}
            >
              <Icon name="message" size={18} />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {session.surface === "work" ? "Work" : "Code"}
                  {session.id === snapshot.activeSessionId
                    ? t(" · 当前会话", " · Current")
                    : ""}
                </small>
              </span>
              <Icon name="chevron" size={15} />
            </button>
          ))}
        </section>
      )}
      <div className="rw-start-note">
        <Icon name="team" size={22} />
        <p>
          {t(
            "一个人开始，也可以让团队协作。",
            "Start a conversation. Bring in a team when you need one.",
          )}
          <span>
            {t(
              "Code 与 Work 会话都支持查看团队和子智能体的进展。",
              "Follow your team and subagents in both Code and Work conversations.",
            )}
          </span>
        </p>
      </div>
      {demo && (
        <button className="rw-text-button rw-demo-link" onClick={onDemo}>
          {t("先看看演示会话", "Explore a demo conversation")}
          <Icon name="chevron" size={15} />
        </button>
      )}
    </div>
  );
}
