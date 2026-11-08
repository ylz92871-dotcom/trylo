import type { CliContext } from "../context.js";
import { enrichSessions } from "../session-list.js";
import { sessionsDir } from "../session-paths.js";
import { relativeTime } from "../humanize.js";
import type { RunScaffold } from "../run-command.js";
import type { TuiIo } from "./io.js";
import { choose } from "./choose.js";
import { wrapLine } from "./frame.js";

export async function selectSession(ctx: CliContext, io: TuiIo, currentId: string): Promise<string | undefined> {
  const sessions = (await enrichSessions(ctx, sessionsDir(ctx.homeDir, ctx.env))).filter(session => !session.archived && session.id !== currentId);
  if (sessions.length === 0) {
    io.write("没有其他可恢复的会话。\n");
    return undefined;
  }
  return choose(io, { title: "恢复会话 · 输入文字筛选", items: sessions.map(session => ({ id: session.id,
    label: session.displayName ?? session.preview ?? session.id,
    detail: `${relativeTime(session.modifiedAtMs, ctx.now())} · ${session.health} · ${session.id}` })) });
}

/** Only the already-restored transcript is rendered; it does not change history. */
export function restoredConversation(scaffold: RunScaffold, columns: number): string {
  const messages = (scaffold.resumeTranscript ?? []).filter(item => item.kind === "user" || item.kind === "assistant_text").slice(-4);
  if (messages.length === 0) return "";

  return ["最近对话", ...messages.flatMap(item => {
    if (item.kind !== "user" && item.kind !== "assistant_text") return [];
    const rows = wrapLine(item.text, Math.max(columns - 3, 10));
    return [`${item.kind === "user" ? "你" : "Trylo"}：`, ...rows.slice(0, 8), ...(rows.length > 8 ? ["… 更早内容仍保存在会话中"] : [])];
  }), ""].join("\n");
}
