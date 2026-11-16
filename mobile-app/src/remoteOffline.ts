import type { GatewayConfig, RemoteSnapshot } from "./gateway";
import type { CachedRemoteConversation } from "./remoteCache";

/** A read-only offline view keeps the cached thread and its identity together. */
export function offlineSnapshot(
  config: GatewayConfig,
  cached: CachedRemoteConversation | null,
): RemoteSnapshot {
  const history =
    config.deviceId && cached?.deviceId === config.deviceId ? cached : null;
  return {
    device: {
      id: config.deviceId || "offline-device",
      name: config.deviceName || "Trylo computer",
      workspace: history?.workspace || "等待电脑上线",
      online: false,
      latencyMs: 0,
      lastSeenAt: history?.at || 0,
    },
    agent: {
      status: "idle",
      title: "电脑暂时离线",
      detail: "App 会在后台继续尝试连接",
      progress: 0,
      elapsed: "",
      mode: "agent",
      phase: "ready",
      finalResponse: null,
      technicalEventCount: 0,
      timeline: [],
    },
    activeSessionId: history?.sessionId || "",
    conversation: history?.messages || [],
    collaboration: history?.collaboration,
    sessions: history
      ? [
          {
            id: history.sessionId,
            title: history.title || "离线会话",
            preview: "",
            surface: history.surface,
            updatedAt: history.at,
          },
        ]
      : [],
    activeProjectId: history?.projectId || "",
    projects: [],
    approvals: [],
  };
}
