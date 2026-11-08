import assert from "node:assert/strict";
import test from "node:test";
import type { LearningIssue } from "../../../../control/coordination-contract.js";
import { createToolLibrary } from "../../../../../tooling/library/index.js";
import type { ToolBinding, ToolPort } from "../../../../../ports/tools.js";
import type { ToolLibraryEntry } from "../../../../../tooling/library/index.js";
import { discoverCollaborationTools } from "./tool-discovery.js";

const scope = "workspace:tool-discovery", NOW = "2026-11-04T00:00:00.000Z";
const issue = (members: readonly string[]): LearningIssue => ({ schemaVersion: 1, issueId: "issue:tool", scope,
  problemKey: "artifact-tool", revision: 1, decision: { kind: "unreviewed" }, createdAt: NOW, updatedAt: NOW,
  reports: members.map((memberId, index) => ({ reportId: `report:${index}`,
    source: { teamRunId: "team:original", taskId: `task:${index}`, memberId }, facts: ["Artifact tool access needs clarification."], evidenceRefs: [] })) });
const binding = (name: string): ToolBinding => ({ name, description: "artifact operation", sideEffect: "read_only", parameters: {},
  needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 30 } });
const entry = (id: string, name = "read_file"): ToolLibraryEntry => ({ id, name, description: "artifact operation", capabilities: ["artifact"],
  source: { kind: "builtin", label: "existing runtime" }, availability: { state: "available" }, runtimeName: name });
const tools: ToolPort = { snapshot: () => ["read_file", "write_file", "run_shell"].map(binding),
  execute: async () => { throw new Error("Discovery cannot execute tools"); }, cancel: async () => { throw new Error("Discovery cannot cancel work"); } };

test("tool discovery keeps PA and member configuration ceilings distinct and never treats a catalogue as execution approval", async () => {
  const library = createToolLibrary({ sources: [{ id: "runtime", read: async () => ({ ok: true,
    value: [entry("runtime:read_file"), entry("runtime:write_file", "write_file"), entry("runtime:run_shell", "run_shell")] }) }],
    access: async context => {
      if (!["personal_agent", "producer", "reviewer"].includes(context.memberId)) return { ok: false, code: "member_unavailable", message: "Not in the frozen team" };
      return { ok: true, value: { tools, configuredNames: context.memberId === "reviewer" ? ["read_file"] : undefined,
        allowedNames: context.memberId === "reviewer" ? ["read_file"] : ["read_file", "write_file", "run_shell"],
        permission: { isDenied: name => name === "run_shell" } } };
    } });
  const found = await discoverCollaborationTools(library, { issue: issue(["producer", "reviewer", "missing", "producer"]),
    query: "artifact", signal: new AbortController().signal, currentTeamRunId: "team:original" });

  assert.equal(found.mode, "discovery_only");
  assert.equal(found.queriedMemberId, "personal_agent");
  assert.match(found.note, /not permission to execute/);
  assert.ok(found.catalog.result.ok);
  assert.equal(found.catalog.result.value.items.find(item => item.name === "write_file")?.configuration, "configurable");
  const reviewer = found.memberViews.find(view => view.memberId === "reviewer");
  assert.ok(reviewer?.binding === "current_team" && reviewer.result.ok);
  assert.equal(reviewer.result.value.items.find(item => item.name === "write_file")?.reason, "outside_task_scope");
  assert.equal(reviewer.result.value.items.find(item => item.name === "write_file")?.configured, false);
  const producer = found.memberViews.find(view => view.memberId === "producer");
  assert.ok(producer?.binding === "current_team" && producer.result.ok);
  assert.equal(producer.result.value.items.find(item => item.name === "run_shell")?.reason, "permission_denied");
  assert.equal(producer.reportSource.taskId, "task:3", "use the latest actual report source for a repeated member");
  const missing = found.memberViews.find(view => view.memberId === "missing");
  assert.ok(missing?.binding === "current_team" && !missing.result.ok);
  assert.equal(missing.result.code, "member_unavailable");
  assert.equal(found.memberViews.length, 3);
});

test("discovery is bounded across members, catalogue items and the canonical resource source-reference limit", async () => {
  const queries: string[] = [];
  const library = createToolLibrary({ sources: [{ id: "runtime", read: async context => ({ ok: true,
    value: Array.from({ length: 20 }, (_, index) => entry(`tool:${context.memberId}:${String(index).padStart(2, "0")}`)) }) }],
    access: async context => {
      queries.push(context.memberId);
      return { ok: true, value: { tools, configuredNames: undefined, permission: {} } };
    } });
  const found = await discoverCollaborationTools(library, { issue: issue(["a", "b", "c", "d", "e", "f", "g"]), query: "artifact",
    signal: new AbortController().signal, currentTeamRunId: "team:original" });

  assert.deepEqual(queries, ["personal_agent", "g", "f", "e", "d"]);
  assert.equal(found.memberViews.length, 4);
  assert.equal(found.omittedMemberCount, 3);
  assert.equal(found.sourceRefs.length, 32);
  assert.ok(found.catalog.result.ok);
  assert.equal(found.catalog.result.value.items.length, 12);
  assert.equal(found.catalog.truncated, true);

  for (const view of found.memberViews) {
    assert.equal(view.binding, "current_team");
    assert.ok(view.binding === "current_team" && view.result.ok);
    assert.ok(view.result.value.items.length <= 6);
    assert.equal(view.result.value.total, 20);
    assert.equal(view.truncated, true);
    for (const item of view.result.value.items) assert.ok(found.sourceRefs.includes(item.id));
  }
});

test("a cancelled discovery performs no catalogue or member reads", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const found = await discoverCollaborationTools({ query: async () => { throw new Error("Cancelled discovery must not query"); } },
    { issue: issue(["producer"]), query: "artifact", signal: cancelled.signal });
  assert.equal(found.catalog.result.ok, false);
  assert.deepEqual(found.memberViews, []);
  assert.deepEqual(found.sourceRefs, []);
  assert.equal(found.omittedMemberCount, 1);
});

test("unknown or historical report teams cannot borrow the current team's same-named member catalogue", async () => {
  const queried: string[] = [];
  const library = createToolLibrary({ sources: [{ id: "runtime", read: async () => ({ ok: true, value: [entry("runtime:read_file")] }) }],
    access: async context => {
      queried.push(context.memberId);
      return { ok: true, value: { tools, configuredNames: undefined, permission: {} } };
    } });

  for (const currentTeamRunId of [undefined, "team:different"]) {
    const found = await discoverCollaborationTools(library, { issue: issue(["producer"]), query: "artifact",
      signal: new AbortController().signal, currentTeamRunId });
    assert.deepEqual(found.memberViews, [{ binding: "unbound_report", memberId: "producer",
      reportSource: { teamRunId: "team:original", taskId: "task:0", memberId: "producer" },
      reason: currentTeamRunId === undefined ? "current_team_unknown" : "historical_team" }]);
  }

  assert.deepEqual(queried, ["personal_agent", "personal_agent"]);
});
