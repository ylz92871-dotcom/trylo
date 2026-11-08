import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { parseLearn } from "./args-learn.js";
import { readAgentLearningDocuments } from "./agent-learning-read-model.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { MethodCard } from "../../learning/agent/subsystems/method/domain/contracts.js";
import type { CollaborationExperienceContent } from "../../learning/agent/subsystems/collaboration/experience/contracts.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createMethodBoardWriter } from "../../learning/agent/subsystems/method/adapters/board-writer.js";
import { nicheOf } from "../../learning/agent/subsystems/method/domain/niche.js";
import { handleAgentLearningRead } from "./commands-agent-learning-read.js";
import type { CliContext } from "./context.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { learnWorkflow } from "../../learning/agent/subsystems/workflow/domain/trace-learn.js";
import { saveWorkflowVersion } from "../../learning/agent/subsystems/workflow/runtime/archive.js";

const scope = "D:/reports";
const card: MethodCard = { schemaVersion: 1, hint: "保留合法零金额记录", appliesWhen: { tools: ["read_file"] }, labels: [],
  lineage: { createdFrom: { turnId: "turn-report", beat: 2, reason: "repeat_call" } } };
const experience: CollaborationExperienceContent = { schema: "collaboration-experience/v1", status: "trial", issueId: "issue-report", focusRevision: 1,
  familyId: "structured-handoff", owner: { kind: "personal_agent", experienceKey: "personal-agent" },
  situation: "复核成员缺少金额单位", responsibilities: ["提供字段与来源"], practice: "交接时同时提供单位与原始资料", conditions: {}, sourceRefs: ["member-feedback:1"] };

function state(): BoardState {
  return { ...emptyBoardState(), assets: [
    { versionId: "method-v1", kind: "prompt_patch", schemaVersion: 1, content: card, contentHash: contentHashOf(card), scope: "niche-report",
      source: "inferred", createdAt: "2026-11-04T01:00:00Z", createdFromProposalId: "method-proposal" },
    { versionId: `collaboration-experience-version:${contentHashOf({ scope, content: experience })}`, kind: "workflow", schemaVersion: 1,
      content: experience, contentHash: contentHashOf(experience), scope, source: "inferred", createdAt: "2026-11-04T01:05:00Z", createdFromProposalId: "collab-proposal" },
  ] };
}

test("inspection accepts only read domains and exact optional identities", () => {
  for (const domain of ["method", "workflow", "collaboration"]) {
    const command = parseLearn(["inspect", domain, "version:one"]);
    assert.equal(command.kind, "learn");
    if (command.kind === "learn") assert.deepEqual(command.options, { subsystem: domain, readOnly: true, versionId: "version:one" });
  }
  for (const args of [["inspect", "routing"], ["inspect", "method", "--activate"], ["inspect", "method", "v1", "extra"]]) {
    assert.equal(parseLearn(args).kind, "error");
  }
});

test("method and collaboration readers keep original version content, source and scope without mutating the Board", () => {
  const board = state(), before = JSON.stringify(board);
  const method = readAgentLearningDocuments(board, "method", scope, "workspace:reports");

  assert.ok(method.ok);
  assert.equal(method.entries[0]?.versionId, "method-v1");
  assert.equal(method.entries[0]?.source, "inferred");
  assert.equal(method.entries[0]?.scope, "niche-report");
  assert.match(method.entries[0]!.markdown, /保留合法零金额记录/);
  const collaboration = readAgentLearningDocuments(board, "collaboration", scope, "workspace:reports");

  assert.ok(collaboration.ok);
  assert.equal(collaboration.entries[0]?.status, "trial");
  assert.deepEqual(JSON.parse(collaboration.entries[0]!.raw), experience);
  assert.equal(JSON.stringify(board), before);
  assert.deepEqual(readAgentLearningDocuments(board, "collaboration", "D:/other", "workspace:other"), { ok: true, entries: [] });
});

test("corrupted immutable content fails closed rather than becoming a readable approved asset", () => {
  const board = state();
  const tampered = { ...board, assets: board.assets.map(asset => ({ ...asset, contentHash: "wrong" })) };
  assert.deepEqual(readAgentLearningDocuments(tampered, "method", scope, "workspace:reports"), { ok: false, reason: "method_archive_corrupt" });
  assert.deepEqual(readAgentLearningDocuments(tampered, "collaboration", scope, "workspace:reports"), { ok: false, reason: "collaboration_archive_corrupt" });
  const malformed = { ...board, assets: board.assets.map(asset => asset.scope === scope ? { ...asset, content: { ...experience, practice: null } } : asset) };
  assert.deepEqual(readAgentLearningDocuments(malformed, "collaboration", scope, "workspace:reports"), { ok: false, reason: "collaboration_archive_corrupt" });
});

test("the CLI reads exact method/workflow versions from their real Board without appending facts", async () => {
  const parent = testScratchPath("agent-learning-read"), prefix = path.join(parent, "fixture-");

  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(prefix), boardRoot = path.join(root, "learning", "board"), output: string[] = [];
  const at = "2026-11-04T01:00:00.000Z";
  const ctx: CliContext = { env: { TRYLO_HOME: root }, homeDir: root, cwd: root, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, readDir: () => [], writeFile: () => false, isDirectory: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => { output.push(text); }, stderr: () => {}, now: () => 0, newId: name => name };

  try {
    const saved = await createMethodBoardWriter(boardRoot).commitCard({ card, nicheId: nicheOf(card), versionId: "method:stored-v1",
      proposalId: "method:proposal-v1", evidenceId: "method:evidence-v1", writeId: "read-fixture", sample: "field missing", observedAt: at });

    assert.ok(saved.ok);
    const task = { scope: workspaceIdentity(root), taskFamily: { id: "report", intentClass: "validate_artifact", checkKind: "acceptance" as const } };
    const learned = learnWorkflow({ ...task, requestId: "request-report", subsystem: "workflow", collect: true,
      budget: { maxEpisodes: 4, maxSteps: 8, maxTokens: 1000 }, traces: [{ ...task, schemaVersion: 1, traceId: "trace-report", source: "imported",
        outcome: "success", steps: [{ nodeId: "check", input: "source.csv", output: "report.md", dependsOn: [], check: "count rows", status: "passed", evidenceRefs: ["check:rows"] }] }] });

    assert.ok(learned.ok);
    const workflow = await saveWorkflowVersion(boardRoot, learned.value, at);
    assert.ok(workflow.ok);
    const before = await readFile(path.join(boardRoot, "board-events.ndjson"), "utf8");

    assert.equal(await handleAgentLearningRead(ctx, { subsystem: "method", readOnly: true, versionId: "method:stored-v1" }), 0);
    assert.match(output.at(-1)!, /保留合法零金额记录/);
    assert.equal(await handleAgentLearningRead(ctx, { subsystem: "workflow", readOnly: true, versionId: workflow.value.versionId }), 0);
    assert.match(output.at(-1)!, /source.csv/);
    assert.match(output.at(-1)!, /report.md/);
    assert.notEqual(await handleAgentLearningRead(ctx, { subsystem: "method", readOnly: true, versionId: "missing-version" }), 0);
    assert.match(output.at(-1)!, /learning_version_not_found/);
    assert.equal(await readFile(path.join(boardRoot, "board-events.ndjson"), "utf8"), before);
  } finally {
    assert.ok(path.resolve(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  }
});
