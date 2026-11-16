import { useState } from "react";
import type { RemoteCollaboration, RemoteMember } from "../gateway";
import { MarkdownMessage, type UiLanguage } from "../ui";
import { Icon } from "./icons";

export function memberStatus(
  status: RemoteMember["status"],
  language: UiLanguage,
) {
  const labels = {
    running: ["进行中", "Working"],
    waiting: ["等待中", "Waiting"],
    done: ["已完成", "Completed"],
    failed: ["未完成", "Failed"],
    cancelled: ["已停止", "Stopped"],
  };
  return labels[status][language === "en" ? 1 : 0];
}

export default function Collaboration({
  data,
  language,
}: {
  data?: RemoteCollaboration;
  language: UiLanguage;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const t = (zh: string, en: string) => (language === "en" ? en : zh);
  const member = data?.members.find((item) => item.id === selected);
  if (member)
    return (
      <div className="rw-member-detail">
        <button className="rw-member-back" onClick={() => setSelected(null)}>
          <Icon name="back" size={18} />
          {t("全部成员", "All members")}
        </button>
        <div className="rw-member-title">
          <h2>{member.name}</h2>
          <span className={`rw-member-status is-${member.status}`}>
            {memberStatus(member.status, language)}
          </span>
        </div>
        {member.durationMs != null && (
          <p className="rw-description">
            {t("用时", "Duration")} {(member.durationMs / 1000).toFixed(1)}s
          </p>
        )}
        {member.prompt && (
          <section>
            <h3>{t("负责的任务", "Task")}</h3>
            <MarkdownMessage text={member.prompt} language={language} />
          </section>
        )}
        {member.error && (
          <p className="rw-error" role="alert">
            {member.error}
          </p>
        )}
        {member.rounds && member.rounds.length > 1 ? (
          member.rounds.map((round) => (
            <section key={round.round} className="rw-member-round">
              <h3>{t(`第 ${round.round} 轮`, `Round ${round.round}`)}</h3>
              {round.prompt && (
                <MarkdownMessage text={round.prompt} language={language} />
              )}
              {round.result && (
                <MarkdownMessage text={round.result} language={language} />
              )}
            </section>
          ))
        ) : member.result ? (
          <section>
            <h3>{t("成员回复", "Response")}</h3>
            <MarkdownMessage text={member.result} language={language} />
          </section>
        ) : (
          <p className="rw-description">
            {member.status === "running"
              ? t(
                  "正在处理，收到回复后会自动更新。",
                  "Working. The response will appear here automatically.",
                )
              : t(
                  "电脑尚未提供回复内容。",
                  "No response content has been provided yet.",
                )}
          </p>
        )}
      </div>
    );
  return (
    <div className="rw-collaboration">
      <h2>{data?.team?.title || t("团队与子智能体", "Team & subagents")}</h2>
      <p className="rw-description">
        {t(
          "查看每位成员负责什么、进展如何，再展开阅读回复。",
          "See what each member is doing, then open their response.",
        )}
      </p>
      {data?.members.length ? (
        <div className="rw-member-list">
          {data.members.map((item) => (
            <button
              className="rw-member-row"
              key={item.id}
              onClick={() => setSelected(item.id)}
            >
              <span className={`rw-member-avatar is-${item.status}`}>
                <Icon
                  name={item.status === "done" ? "check" : "team"}
                  size={19}
                />
              </span>
              <span className="rw-member-copy">
                <strong>{item.name}</strong>
                <small>
                  {item.prompt ||
                    item.result ||
                    t("查看成员详情", "View member details")}
                </small>
                <span className={`rw-member-status is-${item.status}`}>
                  {memberStatus(item.status, language)}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="rw-empty">
          <Icon name="team" size={34} />
          <h2>
            {t("成员参与后会出现在这里", "Members appear when they join")}
          </h2>
          <p>
            {t(
              "在输入框选择团队协作，或由主智能体委派子任务。",
              "Choose team collaboration in the composer, or let the main agent delegate a subtask.",
            )}
          </p>
        </div>
      )}
    </div>
  );
}
