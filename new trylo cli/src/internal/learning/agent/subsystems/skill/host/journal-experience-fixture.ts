import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { createNdjsonSessionStore } from "../../../../../adapters/session-store/ndjson.js";
import { createSubagentCheckpointJournal } from "../../../../../adapters/subagent-checkpoints/journal.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { SubagentCheckpoint } from "../../../../../subagent/checkpoint.js";
import { createSubagentJournalSink } from "../../../../../surface/cli/subagent-sink.js";
import { createJournalSkillOpportunity } from "./journal-opportunity.js";

/** Test-only builder: real locked SessionPort, real sink, real checkpoint chunks. */
export async function journalExperienceFixture(t: TestContext, options: { readonly rootParent?: string; readonly preserveRoot?: boolean } = {}) {
  const parent = options.rootParent ?? tmpdir();

  if (options.rootParent !== undefined) await mkdir(parent, { recursive: true });

  const root = await mkdtemp(path.join(parent, "trylo-skill-delegated-"));
  const filename = path.join(root, "session.ndjson"), sessionId = "parent-session", workspaceId = "workspace";
  const store = createNdjsonSessionStore({ path: filename });

  t.after(async () => {
    await store.release();
    if (!options.preserveRoot) await rm(root, { recursive: true, force: true });
  });
  const at = "2026-11-03T20:00:00.000Z";

  assert.ok((await store.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture",
    model: "fixture", toolCatalogHash: "tools", workspaceId } })).ok);
  let sequence = 0;
  const turn = (turnId: string, turnAt = at) => {
    const sink = createSubagentJournalSink({ session: store, sessionId, turnId, now: () => Date.parse(turnAt) });
    const item = async (payload: JsonObject) => {
      assert.ok((await store.append({ type: "transcript_item", sessionId, turnId, at: turnAt, payload: { ...payload, sequence: sequence++ } })).ok);
    };
    const event = async (kind: "subagent_spawn" | "subagent_update" | "subagent_end" | "observation", payload: JsonObject, attemptId: string) => {
      sink.onEvent(kind, payload, attemptId);
      await sink.flush();
    };

    return {
      item, event,
      start: (text: string) => item({ kind: "user", text }),
      async spawn(taskId: string, callId: string, options: { readonly agentId?: string; readonly resumedFrom?: string;
        readonly root?: string; readonly settle?: "settled" | "unsettled"; readonly toolName?: "spawn_agent" | "delegate_subagent";
        readonly teamMember?: { readonly teamRunId: string; readonly memberId: string } } = {}) {
        const agentId = options.agentId ?? taskId;
        const name = options.toolName ?? (options.resumedFrom === undefined ? "spawn_agent" : "resume_agent");

        await item({ kind: "tool_call", toolCallId: callId, name, arguments: { message: "Inspect the assigned task" } });
        await event("subagent_spawn", { taskId, subagentId: agentId, toolCallId: callId,
          ...(options.teamMember === undefined ? {} : options.teamMember),
          ...(options.resumedFrom === undefined ? {} : { resumedFrom: options.resumedFrom }) }, options.root ?? `att-root-${callId}`);

        if (options.settle !== "unsettled") await item({ kind: "tool_result", toolCallId: callId,
          name, outcome: "succeeded", truncated: false, output: "Child execution started" });
      },
      async checkpoint(taskId: string, agentId: string, transcript: Transcript, round = 1) {
        const checkpoint: SubagentCheckpoint = { version: 1, taskId, agentId, round, phase: "round_ready", nickname: "worker",
          instruction: "PRIVATE_CHECKPOINT_INSTRUCTION", role: "worker", roleBinding: "PRIVATE_ROLE_BINDING",
          allowedTools: ["read_file"], dependencies: [], idleTimeoutMs: 30_000, cursor: 1,
          budget: { tokenLimit: 1000, tokensUsed: 100, tokensRemaining: 900, timeoutMs: 60_000, timeRemainingMs: 50_000, timeoutMode: "active" },
          transcript, forkMessages: [{ role: "system", content: "PRIVATE_FORK_CREDENTIAL" }] };
        const journal = createSubagentCheckpointJournal([], sessionId, payload => event("observation", payload, `att-checkpoint-${turnId}`));

        await journal.save(checkpoint);
      },
      async terminal(payload: JsonObject = { reason: "completed", finishReason: "stop" }) {
        const appended = await store.append({ type: "terminal", sessionId, turnId, at: turnAt, payload });
        assert.ok(appended.ok);
        return appended.sequence;
      },
    };
  };

  return { store, sessionId, workspaceId, filename, turn,
    opportunity(turnId: string, observe?: Parameters<typeof createJournalSkillOpportunity>[0]["observe"]) {
      return createJournalSkillOpportunity({ workspaceRoot: root, workspaceId, source: { sessionId, turnId },
        sessions: () => [{ id: sessionId, path: filename, modifiedAtMs: 1 }], ...(observe === undefined ? {} : { observe }) })(new AbortController().signal);
    } };
}
