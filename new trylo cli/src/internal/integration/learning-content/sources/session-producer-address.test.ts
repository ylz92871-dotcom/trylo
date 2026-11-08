import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNdjsonSessionStore } from "../../../adapters/session-store/ndjson.js";
import { projectWorkflowImprovementEvidence } from "../../../learning/agent/subsystems/workflow/adapters/improvement-evidence.js";
import { skillTaskReport } from "../../../learning/agent/subsystems/skill/index.js";
import type { LearningIssue, LearningIssueReport } from "../../../learning/control/coordination-contract.js";
import { emptyBoardState, type BoardState } from "../../../learning/control/state.js";
import { readSessionContent, sessionSourceAddressesForIssue, sessionTaskAddress } from "./session.js";
import { sessionSourceAddressCatalogForIssue, readIssueSessionSourceCatalog } from "./session-issue-address.js";
import { retrieveContentPacket } from "../../../learning/central/content/material-source.js";

const at = "2026-11-04T17:00:00Z";

function issue(source: LearningIssueReport["source"], evidenceRefs: readonly string[], facts: readonly string[] = ["Original source requirement"]): LearningIssue {
  return { schemaVersion: 1, issueId: "issue:source", scope: "repo:a", problemKey: "source", revision: 1, createdAt: at, updatedAt: at,
    reports: [{ reportId: "report:source", source, facts, evidenceRefs }], decision: { kind: "unreviewed" } };
}

test("actual workflow and skill producer addresses recover original cross-session requirements, and explicit task registry lookup reads the original turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-session-source-producers-"));
  const old = createNdjsonSessionStore({ path: join(root, "old-session.ndjson") }), current = createNdjsonSessionStore({ path: join(root, "current-session.ndjson") });

  try {
    for (const [session, id] of [[old, "old-session"], [current, "current-session"]] as const) assert.ok((await session.start({ sessionId: id, createdAt: at,
      fingerprint: { schemaVersion: "1", providerId: "contract", model: "contract", toolCatalogHash: "catalog", workspaceId: "workspace:a" } })).ok);

    const append = (type: "transcript_item" | "envelope", payload: Parameters<typeof old.append>[0]["payload"]) => old.append({ type, sessionId: "old-session", turnId: "turn-old", at, payload });

    assert.ok((await append("transcript_item", { kind: "user", sequence: 0, text: "Find complete source ownership evidence under the original snapshot." })).ok);
    assert.ok((await append("transcript_item", { kind: "tool_call", sequence: 1, toolCallId: "call-old", name: "read_file", arguments: { path: "owner.ts" } })).ok);
    const event = (kind: string, eventId: string, sequence: number, payload: Parameters<typeof old.append>[0]["payload"]) => ({
      protocolVersion: "0.0", eventId, sequence, timestamp: at, sessionId: "old-session", turnId: "turn-old", attemptId: "attempt-old", producerId: "loop", producerSequence: sequence, kind, payload });

    assert.ok((await append("envelope", { envelope: event("tool_use", "use-old", 0, { name: "read_file", toolCallId: "call-old" }) })).ok);
    assert.ok((await append("transcript_item", { kind: "tool_result", sequence: 2, toolCallId: "call-old", name: "read_file", output: "export function originalOwner() {}", truncated: false, outcome: "succeeded" })).ok);
    assert.ok((await append("envelope", { envelope: event("tool_result", "result-old", 1, { toolCallId: "call-old", status: "succeeded", output: "export function originalOwner() {}" }) })).ok);
    assert.ok((await current.append({ type: "transcript_item", sessionId: "current-session", turnId: "turn-current", at,
      payload: { kind: "user", sequence: 0, text: "Continue the earlier investigation." } })).ok);
    const oldView = await old.readRecords();
    assert.ok(oldView.ok);
    const projected = projectWorkflowImprovementEvidence(oldView.view.records, "old-session");
    assert.ok(projected.ok);
    const workflowIssue = issue({ subsystem: "workflow", taskId: "workflow-learning-budget-opaque", versionId: "workflow-input:v1" }, projected.value.evidence.map(row => row.ref));
    let taskSearches = 0;
    const source = await readSessionContent({ session: current, sessionId: "current-session", turnId: "turn-current", scope: "repo:a", subsystem: "workflow", enabled: () => true,
      lookupSession: async id => id === "old-session" ? old : id === "current-session" ? current : undefined,

      async lookupSessionsForTask(taskId) {
        taskSearches++;
        const ids: string[] = [];
        for (const [reader, id] of [[old, "old-session"], [current, "current-session"]] as const) {
          const records = await reader.readRecords();
          if (records.ok && records.view.records.some(row => row.turnId === taskId)) ids.push(id);
        }
        return ids;
      } }, new AbortController().signal);
    assert.ok(source.ok);
    const recovered = await retrieveContentPacket({ ...source.value.batch, scope: "repo:a", domain: "workflow", boardSequence: 0, focus: workflowIssue }, source.value.source, new AbortController().signal);
    assert.ok(recovered.ok);
    assert.ok(recovered.value.requirements.some(row => row.requirement.includes("original snapshot")));
    assert.equal(sessionSourceAddressesForIssue(workflowIssue).length, 0, "workflow budget IDs are never treated as turns");
    const toolRef = projected.value.evidence.find(row => row.kind !== "user_input")!.ref;
    const toolPage = await source.value.source.readMaterial(toolRef, new AbortController().signal);
    assert.ok(toolPage.ok);
    assert.equal(toolPage.value.text, "export function originalOwner() {}");
    const taskReport = skillTaskReport({ sessionId: "old-session", turnId: "turn-old", transcript: [
      { kind: "user", sequence: 0, text: "Find complete source ownership evidence under the original snapshot." },
      { kind: "tool_result", sequence: 2, toolCallId: "call-old", name: "read_file", output: "export function originalOwner() {}", truncated: false, outcome: "succeeded" },
    ] });
    assert.ok(taskReport);
    const skillIssue = issue({ subsystem: "skill", taskId: taskReport.taskId, versionId: taskReport.versionId! }, taskReport.evidenceRefs, taskReport.facts);
    const skill = await source.value.source.retrieve({ scope: "repo:a", domain: "skill", boardSequence: 0, issueIds: [], topicIds: [], artifactRefs: [],
      sourceRefs: sessionSourceAddressesForIssue(skillIssue) }, new AbortController().signal);
    assert.ok(skill.ok);
    assert.ok(skill.value.requirements.some(row => row.requirement.includes("original snapshot")));
    // A fresh adapter has no old snapshot cached: task IDs require an actual registry search, not filename guessing.
    const fresh = await readSessionContent({ session: current, sessionId: "current-session", turnId: "turn-current", scope: "repo:a", subsystem: "tool", enabled: () => true,
      lookupSession: async id => id === "old-session" ? old : undefined,

      lookupSessionsForTask: async taskId => {
        taskSearches++;
        return taskId === "turn-old" ? ["old-session"] : [];
      } }, new AbortController().signal);
    assert.ok(fresh.ok);
    const found = await fresh.value.source.retrieve({ scope: "repo:a", domain: "tool", boardSequence: 0, issueIds: [], topicIds: [], artifactRefs: [],
      sourceRefs: [sessionTaskAddress("turn-old")] }, new AbortController().signal);
    assert.ok(found.ok);
    assert.ok(found.value.requirements.some(row => row.requirement.includes("original snapshot")));
    assert.equal(taskSearches, 1);
  } finally {
    await old.release();
    await current.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("method source task catalog remains owner-scoped and bounded even when one version has hundreds of foreign or historical uses", () => {
  const focused = issue({ subsystem: "method", taskId: "nomination-current", versionId: "shared-version" }, ["snapshot:1"], ["method_opt_in", "scope:scope:target"]);
  const fielding = (id: string, scope: string) => ({ exposureId: id, versionId: "shared-version", proposalId: "proposal:1", turnId: id,
    beat: 1, requestId: `request:${id}`, scope, recordedAt: at });
  const board: BoardState = { ...emptyBoardState(), learningIssues: [focused], fieldings: [fielding("foreign-task", "scope:foreign"),
    ...Array.from({ length: 300 }, (_, index) => fielding(`local-task-${index}`, "scope:target"))] };
  const addresses = sessionSourceAddressesForIssue(focused, board);
  assert.equal(addresses.length, 3);
  assert.ok(!addresses.includes(sessionTaskAddress("foreign-task")));
  const catalog = sessionSourceAddressCatalogForIssue(focused, board);
  assert.equal(catalog.available, 301);
  assert.ok(catalog.omitted > 0);
  const exact = readIssueSessionSourceCatalog(board, focused.scope, catalog.ref, 0, 8192);
  assert.ok(exact?.ok);
  assert.ok(exact.value.text.includes("scope:target"));
  assert.ok(!exact.value.text.includes("scope:foreign"));
});
