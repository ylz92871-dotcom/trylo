/**
 * Headless-safe ManagedSession runtime core (P1, `executionMode: "solo"` only).
 *
 * This is the minimal runnable contract that Trylo's headless daemon can host
 * without Electron. It mirrors the solo lifecycle of the Electron
 * `ManagedSessionService` (create / list / get / cancel / resume / sendEvent /
 * refresh + backing-task event mirroring) but does NOT import that service or
 * any Electron runtime package.
 *
 * Non-goals for P1 (kept out of this core on purpose):
 *  - team mode (`executionMode: "team"`), managed team runs
 *  - Agents Hub / Agent Builder / studio metadata editing
 *  - routines, Slack / channel deployment, audio summaries, media playback
 *  - MCP registry resolution (fail-closed instead)
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { deriveCanonicalTaskStatus } from "../../shared/task-status";
import type {
  AgentBuilderConnectionRequirement,
  ManagedAgent,
  ManagedAgentVersion,
  ManagedAgentApprovalPolicy,
  ManagedAgentMemoryConfig,
  ManagedAgentStudioConfig,
  ManagedAgentToolFamily,
  ManagedAgentFileRef,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  ManagedSessionEvent,
  ManagedSessionEventType,
  ManagedSessionInputContent,
  ManagedSessionStatus,
  Task,
  TaskEvent,
  AgentToolRestrictions,
  ApprovalType,
} from "../../shared/types";
import type { AgentDaemon } from "../../electron/agent/daemon";
import {
  ArtifactRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../../electron/database/repositories";
import {
  ManagedAgentRepository,
  ManagedAgentVersionRepository,
  ManagedEnvironmentRepository,
  ManagedSessionEventRepository,
  ManagedSessionRepository,
} from "../../electron/managed/repositories";
import type {
  ManagedPermissionAssertion,
  ManagedSessionBridgeEvent,
  ManagedSessionBridgeResult,
  ManagedSessionRuntimeOptions,
  ManagedMcpToolAccessResolver,
} from "./managed-session-runtime-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------------ */
/* Event payload sanitization (mirrors the Electron service's semantics)    */
/* ------------------------------------------------------------------------ */

const MANAGED_EVENT_MAX_STRING_CHARS = 2000;
const MANAGED_EVENT_MAX_ARRAY_ITEMS = 50;
const MANAGED_EVENT_MAX_OBJECT_KEYS = 50;
const MANAGED_EVENT_MAX_DEPTH = 3;
const MANAGED_EVENT_SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;
const MANAGED_EVENT_ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

function sanitizeManagedEventPayload(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MANAGED_EVENT_MAX_DEPTH) return "[... truncated ...]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const maxChars = key === "message" ? 12000 : MANAGED_EVENT_MAX_STRING_CHARS;
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const next = value
      .slice(0, MANAGED_EVENT_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeManagedEventPayload(item, depth + 1));
    if (value.length > MANAGED_EVENT_MAX_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MANAGED_EVENT_MAX_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const nextKey of keys.slice(0, MANAGED_EVENT_MAX_OBJECT_KEYS)) {
      if (MANAGED_EVENT_ALWAYS_REDACT_KEY_RE.test(nextKey) || MANAGED_EVENT_SENSITIVE_KEY_RE.test(nextKey)) {
        out[nextKey] = "[REDACTED]";
        continue;
      }
      out[nextKey] = sanitizeManagedEventPayload(obj[nextKey], depth + 1, nextKey);
    }
    if (keys.length > MANAGED_EVENT_MAX_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MANAGED_EVENT_MAX_OBJECT_KEYS;
    }
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

function normalizeManagedSessionEventPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  return sanitizeManagedEventPayload(payload) as Record<string, unknown>;
}

/* ------------------------------------------------------------------------ */
/* Studio / config helpers                                                    */
/* ------------------------------------------------------------------------ */

function getStudioConfig(version: ManagedAgentVersion): ManagedAgentStudioConfig | undefined {
  const metadata = isRecord(version.metadata) ? version.metadata : undefined;
  const studio = metadata?.studio;
  return isRecord(studio) ? (studio as ManagedAgentStudioConfig) : undefined;
}

function buildReviewCheckpoints(studio?: ManagedAgentStudioConfig): string[] {
  const expected = new Set(studio?.expectedArtifacts || []);
  const checkpoints = ["source-ledger ready"];
  if (expected.has("xlsx")) checkpoints.push("model built");
  if (expected.has("pptx")) checkpoints.push("deck generated");
  if (expected.has("docx") || expected.has("pdf")) checkpoints.push("report generated");
  if (expected.has("json")) checkpoints.push("artifact manifest ready");
  return Array.from(new Set(checkpoints));
}

function listManagedFileRefs(
  fileRefs: ManagedAgentFileRef[] | undefined,
  environment: ManagedEnvironment | undefined,
): string[] {
  const fromStudio = (fileRefs || []).map((file) => file.path).filter(Boolean);
  const fromEnvironment = environment?.config.filePaths || [];
  return Array.from(new Set([...fromStudio, ...fromEnvironment]));
}

function toMemoryToolRestrictions(
  memoryConfig: ManagedAgentMemoryConfig | undefined,
): AgentToolRestrictions | undefined {
  if (memoryConfig?.mode !== "disabled") return undefined;
  return {
    deniedTools: [
      "search_quotes",
      "search_sessions",
      "memory_topics_load",
      "memory_save",
      "memory_curate",
      "memory_curated_read",
      "supermemory_profile",
      "supermemory_search",
      "supermemory_remember",
      "supermemory_forget",
    ],
  };
}

function toManagedApprovalTypes(approvalPolicy?: ManagedAgentApprovalPolicy): ApprovalType[] {
  const requested = new Set(approvalPolicy?.requireApprovalFor || []);
  const allowed = new Set<ApprovalType>();
  if (approvalPolicy?.autoApproveReadOnly !== false) {
    allowed.add("network_access");
  }
  if (!requested.has("edit spreadsheet")) {
    allowed.add("data_export");
  }
  return Array.from(allowed);
}

/**
 * Fail-closed MCP tool access resolution.
 *
 * The headless core deliberately does not reach into the Electron MCP registry.
 * If the environment references MCP servers, we treat every referenced server
 * as "missing/unavailable" (fail-closed): no MCP tools are auto-approved and the
 * missing connections are surfaced into the composed root prompt.
 */
function resolveMcpToolAccess(environment: ManagedEnvironment): {
  allowedTools: string[];
  missingConnections: AgentBuilderConnectionRequirement[];
  hasMcpServerAllowlist: boolean;
} {
  const serverIds = environment.config.allowedMcpServerIds || [];
  if (serverIds.length === 0) {
    return { allowedTools: [], missingConnections: [], hasMcpServerAllowlist: false };
  }
  const missingConnections: AgentBuilderConnectionRequirement[] = serverIds.map((serverId) => ({
    id: serverId,
    kind: "mcp_server",
    label: serverId,
    status: "missing",
    reason: `Managed environment references MCP server "${serverId}", but the headless ManagedSession core does not resolve MCP registries (fail-closed).`,
  }));
  return { allowedTools: [], missingConnections, hasMcpServerAllowlist: true };
}

/* ------------------------------------------------------------------------ */
/* Status / event-type mapping (mirrors Electron helpers)                     */
/* ------------------------------------------------------------------------ */

function toManagedSessionStatus(task?: Task, hasPendingInput = false): ManagedSessionStatus {
  if (!task) return "failed";
  if (hasPendingInput) return "awaiting_input";
  switch (deriveCanonicalTaskStatus(task)) {
    case "pending":
    case "queued":
    case "planning":
      return "pending";
    case "paused":
    case "blocked":
      return "awaiting_input";
    case "executing":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

const TASK_EVENT_TO_MANAGED_TYPE: Record<string, ManagedSessionEventType> = {
  assistant_message: "assistant.message",
  tool_call: "tool.call",
  tool_result: "tool.result",
  input_request_created: "input.requested",
  task_completed: "session.completed",
  error: "session.failed",
  task_status: "status.changed",
  task_paused: "status.changed",
  task_resumed: "status.changed",
  task_cancelled: "status.changed",
  task_interrupted: "status.changed",
};

function mapTaskEventType(event: TaskEvent): ManagedSessionEventType {
  const effectiveType = event.legacyType || event.type;
  return TASK_EVENT_TO_MANAGED_TYPE[effectiveType] || "task.event.bridge";
}

function mapDaemonTaskEvent(type: string): ManagedSessionEventType {
  return TASK_EVENT_TO_MANAGED_TYPE[type] || "task.event.bridge";
}

/* ------------------------------------------------------------------------ */
/* Core service                                                               */
/* ------------------------------------------------------------------------ */

export class ManagedSessionRuntimeService {
  private readonly agentRepo: ManagedAgentRepository;
  private readonly versionRepo: ManagedAgentVersionRepository;
  private readonly environmentRepo: ManagedEnvironmentRepository;
  private readonly sessionRepo: ManagedSessionRepository;
  private readonly sessionEventRepo: ManagedSessionEventRepository;
  private readonly taskRepo: TaskRepository;
  private readonly taskEventRepo: TaskEventRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly inputRequestRepo: InputRequestRepository;
  private readonly artifactRepo: ArtifactRepository;

  private readonly assertPermission: ManagedPermissionAssertion;
  private readonly resolveMcpToolAccess: ManagedMcpToolAccessResolver;
  private readonly log: ManagedSessionRuntimeOptions["log"];

  constructor(
    db: Database.Database,
    private readonly agentDaemon: AgentDaemon,
    options: ManagedSessionRuntimeOptions,
  ) {
    this.agentRepo = new ManagedAgentRepository(db);
    this.versionRepo = new ManagedAgentVersionRepository(db);
    this.environmentRepo = new ManagedEnvironmentRepository(db);
    this.sessionRepo = new ManagedSessionRepository(db);
    this.sessionEventRepo = new ManagedSessionEventRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.taskEventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.artifactRepo = new ArtifactRepository(db);

    this.log = options.log || console;
    if (typeof options?.assertPermission !== "function") {
      throw new Error("ManagedSessionRuntimeService requires an explicit assertPermission policy");
    }
    this.assertPermission = options.assertPermission;
    this.resolveMcpToolAccess = options.resolveMcpToolAccess || resolveMcpToolAccess;
  }

  /* ---------------------------- read accessors --------------------------- */

  listAgents(params?: { limit?: number; offset?: number; status?: ManagedAgent["status"] }): ManagedAgent[] {
    return this.agentRepo.list(params);
  }

  getAgent(agentId: string): { agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | undefined {
    const agent = this.agentRepo.findById(agentId);
    if (!agent) return undefined;
    return { agent, currentVersion: this.versionRepo.find(agent.id, agent.currentVersion) };
  }

  listAgentVersions(agentId: string): ManagedAgentVersion[] {
    return this.versionRepo.list(agentId);
  }

  getAgentVersion(agentId: string, version: number): ManagedAgentVersion | undefined {
    return this.versionRepo.find(agentId, version);
  }

  listEnvironments(params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }): ManagedEnvironment[] {
    return this.environmentRepo.list(params);
  }

  getEnvironment(environmentId: string): ManagedEnvironment | undefined {
    return this.environmentRepo.findById(environmentId);
  }

  /* --------------------------- session lifecycle ------------------------- */

  async createSession(input: ManagedSessionCreateInput): Promise<ManagedSession> {
    const agent = this.agentRepo.findById(input.agentId);
    if (!agent) throw new Error(`Managed agent not found: ${input.agentId}`);
    if (agent.status === "suspended") {
      throw new Error(`Managed agent is suspended and cannot be run: ${agent.name}`);
    }
    if (agent.status === "archived") {
      throw new Error(`Managed agent is archived and cannot be run: ${agent.name}`);
    }
    const version = this.versionRepo.find(agent.id, agent.currentVersion);
    if (!version) throw new Error(`Managed agent version missing: ${agent.id}@${agent.currentVersion}`);
    const environment = this.environmentRepo.findById(input.environmentId);
    if (!environment) throw new Error(`Managed environment not found: ${input.environmentId}`);
    const workspace = this.workspaceRepo.findById(environment.config.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${environment.config.workspaceId}`);
    this.assertPermission(environment.config.workspaceId, "canRunAgents");

    // P1: solo only.
    if (version.executionMode !== "solo") {
      throw new Error(
        `Managed session executionMode "${version.executionMode}" is not supported by the headless runtime yet (P1 supports "solo" only).`,
      );
    }

    const now = Date.now();
    const surface = input.surface || "runtime";
    const backingTaskSource: Task["source"] =
      surface === "agent_panel" ? "managed_agent_panel" : "manual";
    const mcpResolution = this.resolveMcpToolAccess(environment);
    if (mcpResolution.blockingError) {
      throw new Error(mcpResolution.blockingError);
    }
    const userPrompt = this.materializeContent(input.initialEvent?.content || []);
    const baseAgentConfig = this.buildAgentConfig(environment, version, mcpResolution);
    const effectivePrompt = this.composeRootPrompt(
      version,
      userPrompt,
      mcpResolution.missingConnections,
    );
    const studio = getStudioConfig(version);

    const sessionTemplatePayload = {
      selectedTemplate: studio?.templateId,
      requiredPackIds: studio?.requiredPackIds || [],
      requiredConnectorIds: studio?.requiredConnectorIds || [],
      artifactManifest: {
        expectedArtifacts: studio?.expectedArtifacts || [],
      },
      reviewCheckpoints: buildReviewCheckpoints(studio),
      approvalPauses: studio?.approvalPolicy?.requireApprovalFor || [],
      missingConnections: [...(studio?.missingConnections || []), ...mcpResolution.missingConnections],
    };

    const task = this.taskRepo.create({
      title: input.title,
      prompt: effectivePrompt,
      rawPrompt: effectivePrompt,
      userPrompt: userPrompt || effectivePrompt,
      status: "pending",
      source: backingTaskSource,
      workspaceId: environment.config.workspaceId,
      agentConfig: baseAgentConfig,
    });

    const session = this.sessionRepo.create({
      id: randomUUID(),
      agentId: agent.id,
      agentVersion: version.version,
      environmentId: environment.id,
      title: input.title,
      status: "pending",
      surface,
      workspaceId: environment.config.workspaceId,
      backingTaskId: task.id,
      latestSummary: undefined,
    });

    this.sessionEventRepo.create({
      sessionId: session.id,
      timestamp: now,
      type: "session.created",
      payload: {
        agentId: agent.id,
        agentVersion: version.version,
        environmentId: environment.id,
        backingTaskId: task.id,
        surface,
        ...sessionTemplatePayload,
      },
    });
    if (input.initialEvent?.type === "user.message") {
      this.sessionEventRepo.create({
        sessionId: session.id,
        timestamp: now,
        type: "user.message",
        payload: { content: input.initialEvent.content },
      });
    }

    await this.agentDaemon.startTask(task);
    return this.refreshSession(session.id) || session;
  }

  listSessions(params?: {
    limit?: number;
    offset?: number;
    agentId?: string;
    workspaceId?: string;
    status?: ManagedSession["status"];
    surface?: ManagedSession["surface"];
  }): ManagedSession[] {
    return this.sessionRepo.list(params).map((session) => {
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled"
      ) {
        return session;
      }
      return this.refreshSession(session.id) || session;
    });
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.refreshSession(sessionId);
  }

  listSessionEvents(sessionId: string, limit = 500): ManagedSessionEvent[] {
    const session = this.refreshSession(sessionId);
    if (!session) return [];
    return this.sessionEventRepo.listBySessionId(sessionId, limit);
  }

  async cancelSession(sessionId: string): Promise<ManagedSession | undefined> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return undefined;
    this.assertPermission(session.workspaceId, "canRunAgents");
    if (session.backingTaskId) {
      await this.agentDaemon.cancelTask(session.backingTaskId).catch(() => {});
    }
    this.sessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "status.changed",
      payload: { status: "cancelled", reason: "user_cancelled" },
    });
    return this.refreshSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<{ resumed: boolean; session?: ManagedSession }> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return { resumed: false, session };
    this.assertPermission(session.workspaceId, "canResumeSessions");
    const resumed = await this.agentDaemon.resumeTask(session.backingTaskId);
    const refreshed = this.refreshSession(sessionId);
    return { resumed, session: refreshed };
  }

  async sendUserMessage(
    sessionId: string,
    content: ManagedSessionInputContent[],
  ): Promise<ManagedSession | undefined> {
    return this.sendEvent(sessionId, { type: "user.message", content });
  }

  async sendEvent(
    sessionId: string,
    event:
      | { type: "user.message"; content: ManagedSessionInputContent[] }
      | {
          type: "input.received";
          requestId: string;
          answers?: Record<string, unknown>;
          status?: string;
        },
  ): Promise<ManagedSession | undefined> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return undefined;
    this.assertPermission(
      session.workspaceId,
      event.type === "input.received" ? "canAnswerApprovals" : "canRunAgents",
    );

    if (event.type === "user.message") {
      const message = this.materializeContent(event.content);
      this.sessionEventRepo.create({
        sessionId,
        timestamp: Date.now(),
        type: "user.message",
        payload: { content: event.content },
      });
      await this.agentDaemon.sendMessage(session.backingTaskId, message);
      return this.refreshSession(sessionId);
    }

    this.sessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "input.received",
      payload: {
        requestId: event.requestId,
        status: event.status || "submitted",
        answers: event.answers || {},
      },
    });
    await this.agentDaemon.respondToInputRequest({
      requestId: event.requestId,
      status: event.status || "submitted",
      answers: event.answers,
    } as any);
    return this.refreshSession(sessionId);
  }

  /* ------------------------ event bridging (mirror) ---------------------- */

  bridgeTaskEventNotification(
    taskId: string,
    taskEvent: ManagedSessionBridgeEvent,
  ): ManagedSessionBridgeResult {
    const session = this.sessionRepo.findByBackingTaskId(taskId);
    if (!session) return {};
    if (
      taskEvent.eventId &&
      this.sessionEventRepo.hasSourceTaskEvent(session.id, taskEvent.eventId)
    ) {
      return { session: this.refreshSession(session.id) || session };
    }
    const appended = this.sessionEventRepo.create({
      sessionId: session.id,
      timestamp: taskEvent.timestamp || Date.now(),
      type: mapDaemonTaskEvent(taskEvent.type),
      payload: normalizeManagedSessionEventPayload(taskEvent.payload),
      sourceTaskId: taskId,
      sourceTaskEventId: taskEvent.eventId,
    });
    return {
      session: this.refreshSession(session.id) || session,
      appended,
    };
  }

  /* ------------------------------ refresh -------------------------------- */

  refreshSession(sessionId: string): ManagedSession | undefined {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return undefined;
    if (session.backingTaskId) {
      this.syncTaskEvents(session);
    }
    const nextSession = this.sessionRepo.findById(sessionId) || session;

    const task = nextSession.backingTaskId ? this.taskRepo.findById(nextSession.backingTaskId) : undefined;
    const pendingInputs = nextSession.backingTaskId
      ? this.inputRequestRepo.findPendingByTaskId(nextSession.backingTaskId)
      : [];
    const nextStatus = toManagedSessionStatus(task, pendingInputs.length > 0);
    const latestSummary = task?.resultSummary || nextSession.latestSummary;
    const completedAt = task?.completedAt || nextSession.completedAt;

    const updates: Partial<ManagedSession> = {};
    if (nextSession.status !== nextStatus) {
      updates.status = nextStatus;
    }
    if (latestSummary && latestSummary !== nextSession.latestSummary) {
      updates.latestSummary = latestSummary;
    }
    if (!nextSession.startedAt && task?.createdAt) {
      updates.startedAt = task.createdAt;
    }
    if (completedAt && completedAt !== nextSession.completedAt) {
      updates.completedAt = completedAt;
    }
    if (Object.keys(updates).length > 0) {
      const updated = this.sessionRepo.update(nextSession.id, updates);
      if (updates.status && updated) {
        this.sessionEventRepo.create({
          sessionId: updated.id,
          timestamp: Date.now(),
          type:
            updates.status === "completed"
              ? "session.completed"
              : updates.status === "failed"
                ? "session.failed"
                : "status.changed",
          payload: {
            status: updates.status,
            latestSummary: updates.latestSummary || latestSummary,
          },
        });
      }
      return updated || nextSession;
    }
    return nextSession;
  }

  private syncTaskEvents(session: ManagedSession): void {
    if (!session.backingTaskId) return;
    const events = this.taskEventRepo.findByTaskId(session.backingTaskId);
    for (const event of events) {
      if (this.sessionEventRepo.hasSourceTaskEvent(session.id, event.id)) continue;
      this.sessionEventRepo.create({
        sessionId: session.id,
        timestamp: event.timestamp,
        type: mapTaskEventType(event),
        payload: normalizeManagedSessionEventPayload(event.payload),
        sourceTaskId: session.backingTaskId,
        sourceTaskEventId: event.id,
      });
    }
  }

  /* ------------------------------ helpers -------------------------------- */

  private composeRootPrompt(
    version: ManagedAgentVersion,
    userPrompt: string,
    missingConnections: AgentBuilderConnectionRequirement[] = [],
  ): string {
    const promptParts = [version.systemPrompt.trim()];
    const studio = getStudioConfig(version);
    if (studio?.instructions?.operatingNotes?.trim()) {
      promptParts.push("", "Operating notes:", studio.instructions.operatingNotes.trim());
    }
    const fileRefs = listManagedFileRefs(studio?.fileRefs, undefined);
    if (fileRefs.length > 0) {
      promptParts.push("", "Reference files:", ...fileRefs.map((filePath) => `- ${filePath}`));
    }
    if (studio?.memoryConfig?.mode === "disabled") {
      promptParts.push(
        "",
        "Memory policy:",
        "Avoid relying on long-term memory tools unless the user re-enables them.",
      );
    } else if (studio?.memoryConfig?.sources?.length) {
      promptParts.push(
        "",
        "Preferred memory sources:",
        ...studio.memoryConfig.sources.map((source) => `- ${source}`),
      );
    }
    const allMissingConnections = [...(studio?.missingConnections || []), ...missingConnections];
    if (allMissingConnections.length > 0) {
      promptParts.push(
        "",
        "Unavailable integrations:",
        ...allMissingConnections.map((connection) => `- ${connection.label}: ${connection.reason}`),
        "Continue with available context and clearly state when one of these unavailable integrations blocks a requested step.",
      );
    }
    if (userPrompt.trim()) {
      promptParts.push("", "User request:", userPrompt.trim());
    }
    return promptParts.join("\n");
  }

  private materializeContent(content: ManagedSessionInputContent[]): string {
    const lines: string[] = [];
    for (const item of content) {
      if (item.type === "text" && item.text.trim()) {
        lines.push(item.text.trim());
        continue;
      }
      if (item.type === "file") {
        const artifact = this.artifactRepo.findById(item.artifactId);
        lines.push(
          artifact?.path
            ? `[Attached artifact: ${artifact.path}]`
            : `[Attached artifact: ${item.artifactId}]`,
        );
      }
    }
    return lines.join("\n\n").trim();
  }

  private buildAgentConfig(
    environment: ManagedEnvironment,
    version: ManagedAgentVersion,
    mcpToolAccess: ReturnType<ManagedMcpToolAccessResolver>,
  ): import("../../shared/types").AgentConfig {
    const runtimeDefaults = version.runtimeDefaults || {};
    const studio = getStudioConfig(version);
    const agentConfig: import("../../shared/types").AgentConfig = {
      ...(version.model?.providerType ? { providerType: version.model.providerType } : {}),
      ...(version.model?.modelKey ? { modelKey: version.model.modelKey } : {}),
      ...(version.model?.llmProfile ? { llmProfile: version.model.llmProfile } : {}),
      ...(runtimeDefaults.autonomousMode !== undefined
        ? { autonomousMode: runtimeDefaults.autonomousMode }
        : {}),
      ...(runtimeDefaults.requireWorktree || environment.config.requireWorktree
        ? { requireWorktree: true }
        : {}),
      ...(runtimeDefaults.allowUserInput !== undefined
        ? { allowUserInput: runtimeDefaults.allowUserInput }
        : {}),
      ...(environment.config.enableShell ? { shellAccess: true } : {}),
      ...(typeof runtimeDefaults.maxTurns === "number" ? { maxTurns: runtimeDefaults.maxTurns } : {}),
      ...(runtimeDefaults.webSearchMode ? { webSearchMode: runtimeDefaults.webSearchMode as any } : {}),
      ...(runtimeDefaults.toolRestrictions?.length
        ? { toolRestrictions: [...runtimeDefaults.toolRestrictions] }
        : {}),
    };

    const memoryRestrictions = toMemoryToolRestrictions(studio?.memoryConfig)?.deniedTools || [];
    if (memoryRestrictions.length > 0) {
      agentConfig.toolRestrictions = Array.from(
        new Set([...(agentConfig.toolRestrictions || []), ...memoryRestrictions]),
      );
    }

    const managedApprovalTypes = toManagedApprovalTypes(studio?.approvalPolicy);
    if (managedApprovalTypes.length > 0) {
      agentConfig.autoApproveTypes = Array.from(
        new Set([...(agentConfig.autoApproveTypes || []), ...managedApprovalTypes]),
      );
    }
    if (studio?.approvalPolicy) {
      agentConfig.allowUserInput = true;
      agentConfig.pauseForRequiredDecision = true;
    }

    const allowedTools = new Set<string>(runtimeDefaults.allowedTools || []);
    for (const tool of mcpToolAccess.allowedTools) allowedTools.add(tool);
    if (allowedTools.size > 0 || mcpToolAccess.hasMcpServerAllowlist) {
      agentConfig.allowedTools = Array.from(allowedTools);
    }

    return agentConfig;
  }
}

// Re-export helper for consumers that need a fail-closed MCP list without
// instantiating the service.
export { sanitizeManagedEventPayload };
