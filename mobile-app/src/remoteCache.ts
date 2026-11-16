import type { DirectAttachment } from "./directChat";
import type {
  RemoteChatMessage,
  RemoteSurface,
  RemoteCollaboration,
  RemoteMember,
} from "./gateway";

/**
 * Read-only on-device cache for the REMOTE conversation.
 *
 * The computer stays the single authority: this cache is written whenever a
 * fresh snapshot / history arrives and is only ever READ when the gateway is
 * unreachable (offline展位). Nothing here is written back to the server, and
 * Code / Work surfaces share the same per-session slot because the Desktop
 * already keeps them as separate sessions server-side.
 *
 * Storage budget mirrors the direct-chat tradeoff: thumbnails stay, full
 * image bytes (`sendData`) and long text excerpts are dropped so a few
 * photos cannot blow the ~5MB localStorage quota.
 */

const CACHE_STORAGE_KEY = "trylo.remote.cache.v1";
const MAX_SESSIONS = 10;
const MAX_MESSAGES_PER_SESSION = 60;
const MAX_MESSAGE_CHARS = 24_000;
const MAX_ATTACHMENT_TEXT_CHARS = 400;

export interface CachedRemoteConversation {
  sessionId: string;
  deviceId?: string;
  workspace: string;
  messages: RemoteChatMessage[];
  at: number;
  projectId?: string;
  surface?: RemoteSurface;
  title?: string;
  collaboration?: RemoteCollaboration;
}

/** Offline excerpts are read-only and share the conversation's storage budget. */
function cacheCollaboration(
  data?: RemoteCollaboration,
): RemoteCollaboration | undefined {
  if (!data || !Array.isArray(data.members)) return undefined;
  const excerpt = (value?: string) =>
    typeof value === "string" && value.length > 6000
      ? `${value.slice(0, 6000)}\n…`
      : value;
  return {
    canStartTeam: false,
    profiles: [],
    team:
      data.team &&
      typeof data.team.id === "string" &&
      typeof data.team.title === "string"
        ? {
            id: data.team.id,
            title: data.team.title,
            status: String(data.team.status || ""),
          }
        : null,
    members: data.members
      .filter(
        (member) =>
          member &&
          typeof member.id === "string" &&
          typeof member.name === "string" &&
          ["running", "waiting", "done", "failed", "cancelled"].includes(
            member.status,
          ),
      )
      .slice(-20)
      .map((member): RemoteMember => ({
        id: member.id,
        name: member.name,
        status: member.status,
        prompt: excerpt(member.prompt),
        result: excerpt(member.result),
        error: excerpt(member.error),
        durationMs: member.durationMs,
        rounds: Array.isArray(member.rounds)
          ? member.rounds
              .slice(-2)
              .map((round: NonNullable<RemoteMember["rounds"]>[number]) => ({
                round: round.round,
                prompt: excerpt(round.prompt) || "",
                result: excerpt(round.result) || "",
              }))
          : undefined,
      })),
  };
}

type RemoteCacheFile = Record<string, CachedRemoteConversation>;

function stripAttachment(attachment: DirectAttachment): DirectAttachment {
  const { sendData: _sendData, ...rest } = attachment;
  if (
    rest.kind === "text" &&
    rest.text &&
    rest.text.length > MAX_ATTACHMENT_TEXT_CHARS
  ) {
    return {
      ...rest,
      text: `${rest.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}…`,
    };
  }
  return rest;
}

function sanitizeMessage(message: RemoteChatMessage): RemoteChatMessage | null {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return null;
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "thinking" &&
    message.role !== "tool"
  )
    return null;
  const text = String(message.text || "").slice(0, MAX_MESSAGE_CHARS);
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .filter(
          (attachment) =>
            attachment &&
            typeof attachment === "object" &&
            (attachment.kind === "image" || attachment.kind === "text"),
        )
        .slice(0, 6)
        .map(stripAttachment)
    : [];
  if (!text && attachments.length === 0 && message.role !== "tool") return null;
  return {
    id: String(message.id || "").slice(0, 200),
    role: message.role,
    ...(message.title ? { title: String(message.title).slice(0, 120) } : {}),
    text,
    at:
      typeof message.at === "number" || typeof message.at === "string"
        ? message.at
        : Date.now(),
    ...(message.status ? { status: message.status } : {}),
    ...(message.mode ? { mode: message.mode } : {}),
    ...(message.turnId ? { turnId: String(message.turnId).slice(0, 200) } : {}),
    ...(message.toolCallId
      ? { toolCallId: String(message.toolCallId).slice(0, 200) }
      : {}),
    ...(typeof message.input === "string"
      ? {
          input:
            message.input.length > 2000
              ? `${message.input.slice(0, 2000)}\n…`
              : message.input,
        }
      : {}),
    ...(typeof message.output === "string"
      ? {
          output:
            message.output.length > 2000
              ? `${message.output.slice(0, 2000)}\n…`
              : message.output,
        }
      : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function sanitizeMessages(
  messages: readonly RemoteChatMessage[],
): RemoteChatMessage[] {
  return messages
    .slice(-MAX_MESSAGES_PER_SESSION)
    .map(sanitizeMessage)
    .filter((message): message is RemoteChatMessage => Boolean(message));
}

export function loadRemoteCache(): RemoteCacheFile {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CACHE_STORAGE_KEY) || "{}",
    ) as RemoteCacheFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const entries = Object.values(parsed).filter(
      (entry): entry is CachedRemoteConversation =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof entry.sessionId === "string" &&
        Array.isArray(entry.messages),
    );
    entries.sort((a, b) => b.at - a.at);
    return Object.fromEntries(
      entries
        .slice(0, MAX_SESSIONS)
        .map((entry) => [
          `${entry.deviceId || "legacy"}:${entry.sessionId}`,
          {
            ...entry,
            messages: sanitizeMessages(entry.messages),
            collaboration: cacheCollaboration(entry.collaboration),
          },
        ]),
    );
  } catch {
    return {};
  }
}

function persistCache(cache: RemoteCacheFile) {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage may be full; the live snapshot stays authoritative regardless.
  }
}

/** Record the latest server-authoritative conversation for one session. */
export function saveRemoteConversation(
  sessionId: string,
  workspace: string,
  messages: RemoteChatMessage[],
  deviceId?: string,
  context: {
    projectId?: string;
    surface?: RemoteSurface;
    title?: string;
    collaboration?: RemoteCollaboration;
  } = {},
) {
  if (!sessionId) return;
  const clean = sanitizeMessages(messages);
  const cache = loadRemoteCache();
  cache[`${deviceId || "legacy"}:${sessionId}`] = {
    sessionId,
    deviceId,
    workspace: String(workspace || ""),
    messages: clean,
    at: Date.now(),
    ...context,
    collaboration: cacheCollaboration(context.collaboration),
  };
  const entries = Object.values(cache)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SESSIONS);
  persistCache(
    Object.fromEntries(
      entries.map((entry) => [
        `${entry.deviceId || "legacy"}:${entry.sessionId}`,
        entry,
      ]),
    ),
  );
}

/** Newest cached conversation across sessions (for the offline展位). */
export function readLatestCachedConversation(
  deviceId?: string,
): CachedRemoteConversation | null {
  const entries = Object.values(loadRemoteCache())
    .filter((entry) => !!deviceId && entry.deviceId === deviceId)
    .sort((a, b) => b.at - a.at);
  return entries[0] || null;
}
