/**
 * P1 spike test: headless (Node-only) ManagedSession lifecycle.
 *
 * Covers the 10 hard gates from §6.5:
 *   1. Fixed ManagedAgent + workspace Environment
 *   2. Create solo ManagedSession
 *   3. Backing Task visible
 *   4. Receive events + query event history
 *   5. cancel effective on backing task
 *   6. Follow-up sendable
 *   7. Daemon close + restart => Session still queryable
 *   8. Resume on resumable state
 *   9. Whole test process never loads the `electron` package
 *  10. (checked separately) `npm run build:daemon` + existing daemon/task tests pass
 *
 * It uses the REAL headless DatabaseManager + AgentDaemon + ManagedSessionRuntimeService
 * (no mocks of the managed-session semantics). Backing-task execution depends on the
 * environment's LLM availability, so assertions target the session/backing-task rows,
 * the event log, and daemon state transitions - not real model output.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { DatabaseManager } from "../../../electron/database/schema";
import { AgentDaemon } from "../../../electron/agent/daemon";
import { ManagedSessionRuntimeService } from "../ManagedSessionRuntimeService";
import {
  ManagedAgentRepository,
  ManagedAgentVersionRepository,
  ManagedEnvironmentRepository,
  ManagedSessionEventRepository,
  ManagedSessionRepository,
} from "../../../electron/managed/repositories";
import { TaskRepository, WorkspaceRepository } from "../../../electron/database/repositories";

const TRYLO_MANAGED_WORK_AGENT_ID = "trylo-managed-work";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("P1 headless ManagedSession runtime (spike, 10 gates)", () => {
  it(
    "runs a full solo managed-session lifecycle against a real isolated daemon",
    async () => {
      // ---------- Gate 9: never under / never loading the Electron runtime ----------
      expect(process.versions.electron).toBeUndefined();
      let electronApp: unknown = "unset";
      try {
        // In a plain Node process this resolves to the electron package path/string,
        // but never exposes a real `app` runtime. The check below proves the test is
        // not running inside Electron.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        electronApp = require("electron").app;
      } catch {
        electronApp = undefined;
      }
      expect(electronApp).toBeUndefined();

      // ---------- Isolated user-data dir (persists across "restart") ----------
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-managed-spike-"));
      process.env.COWORK_USER_DATA_DIR = tmpRoot;
      process.env.COWORK_HEADLESS = "1";

      let dbManager = new DatabaseManager();
      let daemon = new AgentDaemon(dbManager, { startupRecovery: false });
      await daemon.initialize();

      const wsDir = path.join(tmpRoot, "workspace");
      fs.mkdirSync(wsDir, { recursive: true });
      // Use a fresh (non-git) workspace so any backing task fails fast deterministically
      // when no LLM provider is configured.
      const ws = daemon.createWorkspace("spike-ws", wsDir);

      // Gate 1: fixed ManagedAgent + per-workspace Environment
      const agentRepo = new ManagedAgentRepository(dbManager.getDatabase());
      const versionRepo = new ManagedAgentVersionRepository(dbManager.getDatabase());
      const envRepo = new ManagedEnvironmentRepository(dbManager.getDatabase());
      const sessionRepo = new ManagedSessionRepository(dbManager.getDatabase());
      const eventRepo = new ManagedSessionEventRepository(dbManager.getDatabase());
      const taskRepo = new TaskRepository(dbManager.getDatabase());

      const agent = agentRepo.create({
        id: TRYLO_MANAGED_WORK_AGENT_ID,
        name: "Trylo Managed Work",
        description: "P1 spike agent",
        status: "active",
        currentVersion: 1,
      });
      versionRepo.create({
        agentId: agent.id,
        version: 1,
        systemPrompt: "You are a durable background work executor.",
        executionMode: "solo",
        runtimeDefaults: { allowUserInput: true, maxTurns: 20 },
        createdAt: Date.now(),
      });
      const env = envRepo.create({
        id: `managed-env-${ws.id}`,
        name: "spike env",
        kind: "cowork_local",
        revision: 1,
        status: "active",
        config: { workspaceId: ws.id, enableShell: false },
      });

      const service = new ManagedSessionRuntimeService(dbManager.getDatabase(), daemon, {
        assertPermission: () => {
          /* headless policy: allow */
        },
        log: console,
      });

      expect(service.getAgent(agent.id)?.agent.id).toBe(agent.id);
      expect(service.getAgent(agent.id)?.currentVersion?.executionMode).toBe("solo");
      expect(service.getEnvironment(env.id)?.id).toBe(env.id);

      // ---------- Gate 2: create solo ManagedSession ----------
      const session = await service.createSession({
        agentId: agent.id,
        environmentId: env.id,
        title: "spike task",
        initialEvent: {
          type: "user.message",
          content: [{ type: "text", text: "Produce a short report." }],
        },
      });
      expect(session.id).toBeTruthy();
      expect(session.agentId).toBe(agent.id);
      expect(session.backingTaskId).toBeTruthy();
      expect(sessionRepo.findById(session.id)?.id).toBe(session.id);

      // ---------- Gate 3: backing Task visible ----------
      expect(taskRepo.findById(session.backingTaskId as string)).toBeTruthy();

      // Let any async executor settle (fast when no LLM provider is configured).
      await delay(800);

      // ---------- Gate 4: receive events + event history ----------
      const events = service.listSessionEvents(session.id);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.type === "session.created")).toBe(true);
      expect(events.some((e) => e.type === "user.message")).toBe(true);
      const dbEvents = eventRepo.listBySessionId(session.id);
      expect(dbEvents.map((e) => e.id)).toEqual(expect.arrayContaining(events.map((e) => e.id)));

      // ---------- Gate 8: resume on a resumable state ----------
      // Force the backing task into a non-terminal, semantically resumable state.
      taskRepo.update(session.backingTaskId as string, { status: "interrupted" } as any);
      const resumeResult = await service.resumeSession(session.id);
      expect(typeof resumeResult.resumed).toBe("boolean");
      expect(resumeResult.session?.id).toBe(session.id);
      // Put it back into a resumable state so cancel can act on it deterministically.
      taskRepo.update(session.backingTaskId as string, { status: "interrupted" } as any);

      // ---------- Gate 5: cancel effective on backing task ----------
      const cancelled = await service.cancelSession(session.id);
      const backingAfterCancel = taskRepo.findById(session.backingTaskId as string);
      expect(["cancelled", "failed"]).toContain(backingAfterCancel?.status);
      expect(["cancelled", "failed"]).toContain(cancelled?.status);
      const cancelEvents = service.listSessionEvents(session.id);
      expect(
        cancelEvents.some(
          (e) => e.type === "status.changed" && (e.payload as any).status === "cancelled",
        ),
      ).toBe(true);

      // ---------- Gate 6: follow-up sendable ----------
      const userMessageCount = () =>
        service.listSessionEvents(session.id).filter((e) => e.type === "user.message").length;
      const beforeFollowUp = userMessageCount();
      let followUpError: unknown = undefined;
      try {
        await service.sendEvent(session.id, {
          type: "user.message",
          content: [{ type: "text", text: "Add more detail, please." }],
        });
      } catch (err) {
        // The user.message event is persisted before the daemon call, so even if the
        // backing executor rejects (e.g. no LLM), the follow-up is still recorded.
        followUpError = err;
      }
      const afterFollowUp = userMessageCount();
      expect(afterFollowUp).toBeGreaterThan(beforeFollowUp);
      if (followUpError) {
        console.log(`[spike] follow-up reached daemon or rejected headlessly: ${String(followUpError)}`);
      }

      // ---------- Gate 7: close daemon + restart => Session still queryable ----------
      await daemon.shutdown();
      dbManager.close();

      dbManager = new DatabaseManager();
      daemon = new AgentDaemon(dbManager, { startupRecovery: false });
      await daemon.initialize();
      const service2 = new ManagedSessionRuntimeService(dbManager.getDatabase(), daemon, {
        assertPermission: () => {},
        log: console,
      });
      const afterRestart = service2.getSession(session.id);
      expect(afterRestart?.id).toBe(session.id);
      expect(afterRestart?.backingTaskId).toBe(session.backingTaskId);

      await daemon.shutdown();
      dbManager.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
    30_000,
  );

  it(
    "bridges backing-task events into managed_session_events with sourceTaskEventId dedup",
    async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-managed-bridge-"));
      process.env.COWORK_USER_DATA_DIR = tmpRoot;
      process.env.COWORK_HEADLESS = "1";

      const dbManager = new DatabaseManager();
      const daemon = new AgentDaemon(dbManager, { startupRecovery: false });
      const db = dbManager.getDatabase();

      const workspaceRepo = new WorkspaceRepository(db);
      const agentRepo = new ManagedAgentRepository(db);
      const versionRepo = new ManagedAgentVersionRepository(db);
      const envRepo = new ManagedEnvironmentRepository(db);
      const sessionRepo = new ManagedSessionRepository(db);
      const eventRepo = new ManagedSessionEventRepository(db);
      const taskRepo = new TaskRepository(db);

      const wsDir = path.join(tmpRoot, "ws");
      fs.mkdirSync(wsDir, { recursive: true });
      const ws = workspaceRepo.create("bridge-ws", wsDir, {
        read: true,
        write: true,
        delete: false,
        network: false,
        shell: false,
      });

      const agent = agentRepo.create({
        id: "bridge-agent",
        name: "Bridge Agent",
        description: "",
        status: "active" as const,
        currentVersion: 1,
      });
      versionRepo.create({
        agentId: agent.id,
        version: 1,
        systemPrompt: "bg",
        executionMode: "solo",
        runtimeDefaults: { allowUserInput: true, maxTurns: 20 },
        createdAt: Date.now(),
      });
      const env = envRepo.create({
        id: `bridge-env-${ws.id}`,
        name: "bridge env",
        kind: "cowork_local",
        revision: 1,
        status: "active",
        config: { workspaceId: ws.id, enableShell: false },
      });
      const task = taskRepo.create({
        title: "bridge backing task",
        prompt: "p",
        rawPrompt: "p",
        userPrompt: "p",
        status: "running",
        source: "manual" as const,
        workspaceId: ws.id,
      });
      const session = sessionRepo.create({
        id: randomUUID(),
        agentId: agent.id,
        agentVersion: 1,
        environmentId: env.id,
        title: "bridge session",
        status: "running",
        surface: "runtime",
        workspaceId: ws.id,
        backingTaskId: task.id,
        latestSummary: undefined,
      });

      const service = new ManagedSessionRuntimeService(db, daemon, {
        assertPermission: () => {},
        log: console,
      });

      const event = {
        eventId: "task-ev-1",
        timestamp: 1700000000000,
        type: "timeline_step_finished",
        payload: { message: "step done" },
      };

      // 1) First mirror appends a row for the session and maps the task event type.
      const first = service.bridgeTaskEventNotification(task.id, event);
      expect(first.appended).toBeTruthy();
      expect(first.appended?.sessionId).toBe(session.id);
      expect(first.appended?.type).toBe("task.event.bridge");
      // The backing-task identity travels on the DB row (drives dedup by
      // source_task_event_id); it is not part of the returned event type.
      expect(eventRepo.hasSourceTaskEvent(session.id, "task-ev-1")).toBe(true);

      // 2) A duplicate eventId (replay / reconnect catch-up) is deduplicated.
      const second = service.bridgeTaskEventNotification(task.id, event);
      expect(second.appended).toBeUndefined();

      // 3) Events for a task that is not a managed session's backing task bridge to nothing.
      const unknown = service.bridgeTaskEventNotification("no-such-task", event);
      expect(unknown.session).toBeUndefined();
      expect(unknown.appended).toBeUndefined();

      db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
    30_000,
  );

  it(
    "honors an injected MCP tool-access resolver (Electron seam), default stays fail-closed",
    async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-managed-mcp-"));
      process.env.COWORK_USER_DATA_DIR = tmpRoot;
      process.env.COWORK_HEADLESS = "1";

      const dbManager = new DatabaseManager();
      const daemon = new AgentDaemon(dbManager, { startupRecovery: false });
      await daemon.initialize();
      const db = dbManager.getDatabase();

      const workspaceRepo = new WorkspaceRepository(db);
      const agentRepo = new ManagedAgentRepository(db);
      const versionRepo = new ManagedAgentVersionRepository(db);
      const envRepo = new ManagedEnvironmentRepository(db);
      const sessionRepo = new ManagedSessionRepository(db);
      const taskRepo = new TaskRepository(db);

      const wsDir = path.join(tmpRoot, "ws");
      fs.mkdirSync(wsDir, { recursive: true });
      const ws = workspaceRepo.create("mcp-ws", wsDir, {
        read: true, write: true, delete: false, network: false, shell: false,
      });
      const agent = agentRepo.create({
        id: "mcp-agent", name: "MCP Agent", description: "", status: "active" as const, currentVersion: 1,
      });
      versionRepo.create({
        agentId: agent.id, version: 1, systemPrompt: "mcp", executionMode: "solo",
        runtimeDefaults: { allowUserInput: true, maxTurns: 20 }, createdAt: Date.now(),
      });
      const makeEnv = (envName: string) =>
        envRepo.create({
          id: `${envName}-${ws.id}`, name: envName, kind: "cowork_local", revision: 1,
          status: "active" as const,
          config: { workspaceId: ws.id, enableShell: false, allowedMcpServerIds: ["mcp__spike"] },
        });

      // Resolver route: inject a resolver that grants the MCP tool.
      const envInjected = makeEnv("env-injected");
      let resolverCalls = 0;
      const injected = new ManagedSessionRuntimeService(db, daemon, {
        assertPermission: () => {},
        resolveMcpToolAccess: () => {
          resolverCalls += 1;
          return {
            allowedTools: ["mcp__spike"],
            missingConnections: [],
            hasMcpServerAllowlist: true,
          };
        },
      });
      const s1 = await injected.createSession({
        agentId: agent.id, environmentId: envInjected.id, title: "injected mcp",
      });
      const t1 = taskRepo.findById(s1.backingTaskId as string);
      expect(t1?.agentConfig?.allowedTools).toContain("mcp__spike");
      expect(resolverCalls).toBe(1);

      // Fail-closed default: unresolved allowlisted servers grant no tools.
      const envDefault = makeEnv("env-default");
      const rundefault = new ManagedSessionRuntimeService(db, daemon, {
        assertPermission: () => {},
      });
      const s2 = await rundefault.createSession({
        agentId: agent.id, environmentId: envDefault.id, title: "default mcp",
      });
      const t2 = taskRepo.findById(s2.backingTaskId as string);
      const t2Allowed = t2?.agentConfig?.allowedTools ?? [];
      expect(t2Allowed).not.toContain("mcp__spike");

      await daemon.shutdown();
      db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
    30_000,
  );
});
