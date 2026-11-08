import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore, createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { mapSkillDraft } from "../../integration/content/skill.js";
import { induceSkill, type SkillEpisode } from "../../learning/domains/skill/index.js";
import { passEvidence } from "../../learning/control/fixtures.js";
import { learnedSkillCatalog } from "../../integration/skill-learning/catalog.js";
import { createSkillExperienceFile } from "../../integration/skill-learning/experience-file.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { CliContext } from "./context.js";
import { createSkillDailyManagement, skillDailyManagementPaths } from "./skill-daily-management.js";
import { createSkillTools } from "../../adapters/tools/skill/index.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { sessionPath } from "./session-paths.js";
import { skillJournalUses, skillUseBeforeCheck } from "./skill-journal-usage.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";

const AT = "2026-11-03T00:00:00.000Z";
const family = { id: "report", intentClass: "normalize_report", checkKind: "acceptance" as const };

test("management reopens Board versions and usage, rejects foreign scopes, and withdrawal removes next-task consumption", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-skill-management-"));

  t.after(() => {
    assert.equal(path.dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  const ctx: CliContext = { cwd: path.join(root, "workspace"), homeDir: root, env: { TRYLO_HOME: path.join(root, "profile") }, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: directory => existsSync(directory) ? readdirSync(directory).map(name => ({ name, bytes: statSync(path.join(directory, name)).size, modifiedAtMs: 0 })) : [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => Date.parse(AT), newId: prefix => prefix };
  const paths = skillDailyManagementPaths(ctx), store = createFileBoardStore(paths.boardRoot);

  assert.ok("apply" in store);
  const episode = (id: string, outcome: "success" | "failure"): SkillEpisode => ({ id, outcome, taskFamily: family,
    trajectory: { nodeIds: ["read", "check"], stepCount: 2, hadChecks: true, hadFailureRecovery: false },
    steps: ["read all rows", "retain zero values"], checks: ["independent report verifier"], ...(outcome === "failure" ? { failureMode: "zero rows lost" } : {}) });
  const induced = induceSkill([episode("s1", "success"), episode("s2", "success"), episode("f1", "failure")]);

  assert.equal(induced.kind, "draft");
  if (induced.kind !== "draft") return;

  const draft = induced.draft, versionId = "managed-version-1";
  const proposal = mapSkillDraft(draft, { commandId: "submit", issuedAt: AT, risk: "low", hypothesis: "preserve rows", requiredVerifiers: [] });

  assert.ok(proposal.ok);
  const content = { kind: "learned_skill", schemaVersion: 1, workspaceId: paths.workspaceId, experienceDigest: "experiences-1", sourceOpportunityId: "opportunity-1", draft };
  // Synthetic reducer evidence is confined to this management test; runtime
  // independent receipt admission is covered by the runtime contract tests.
  const commands: BoardCommand[] = [...proposal.value,
    { type: "commit_asset", commandId: "commit", issuedAt: AT, proposalId: draft.id, versionId, schemaVersion: 1, content },
    { type: "quarantine", commandId: "quarantine", issuedAt: AT, proposalId: draft.id },
    { type: "start_evaluation", commandId: "evaluate", issuedAt: AT, proposalId: draft.id },
    { type: "record_evidence", commandId: "evidence", issuedAt: AT, evidence: passEvidence(draft.id) },
    { type: "enter_shadow", commandId: "shadow", issuedAt: AT, proposalId: draft.id, versionId }];

  for (const command of commands) assert.ok((await store.apply(command)).ok);

  const loaded = await store.load();
  assert.ok(loaded.ok);
  const asset = loaded.state.assets[0]!;

  await store.close();
  const catalog = learnedSkillCatalog({ state: loaded.state, contentRoot: ctx.cwd, context: { workspaceId: paths.workspaceId, taskFamily: family } }).catalog;

  assert.ok(catalog);
  const name = catalog.list()[0]!.name, sessionId = "later-session", turnId = "later-turn";
  const tool = await createSkillTools(catalog).execute({ name: "skill", toolCallId: "load", arguments: { skill: name } }, new AbortController().signal);

  assert.equal(tool.outcome, "result");
  if (tool.outcome !== "result") return;

  const transcript: Transcript = [ { sequence: 0, kind: "user", text: "Make a new report" },
    { sequence: 3, kind: "tool_call", toolCallId: "load", name: "skill", arguments: { skill: name } },
    { sequence: 4, kind: "tool_result", toolCallId: "load", name: "skill", output: tool.output, truncated: false, outcome: "succeeded" } ];
  const envelope: Envelope = { protocolVersion: "0.0", eventId: "successful-skill", sequence: 2, timestamp: AT, sessionId, turnId,
    producerId: "execution", producerSequence: 2, kind: "tool_result", payload: { toolCallId: "load", name: "skill", status: "succeeded", value: tool.value, output: tool.output, truncated: false } };
  const usageInput = { state: loaded.state, workspaceId: paths.workspaceId, contentRoot: ctx.cwd, sessionId, turnId, transcript, events: [envelope] };
  const actualUses = skillJournalUses(usageInput);
  assert.equal(actualUses.length, 1);
  assert.equal(skillUseBeforeCheck(actualUses, loaded.state, family, 2), undefined, "a failure before load cannot punish the skill loaded for its repair");
  assert.equal(skillUseBeforeCheck(actualUses, loaded.state, family, 6)?.versionId, versionId);
  assert.equal(skillJournalUses({ ...usageInput, events: [{ ...envelope, payload: { ...envelope.payload, status: "failed" } }] }).length, 0);
  assert.equal(skillJournalUses({ ...usageInput, events: [{ ...envelope, turnId: "other-turn" }] }).length, 0);
  assert.equal(skillJournalUses({ ...usageInput, transcript: transcript.map(item => item.kind === "tool_result" ? { ...item, truncated: true } : item) }).length, 0);
  assert.equal(skillJournalUses({ ...usageInput, events: [{ ...envelope, payload: { ...envelope.payload, value: { ...tool.value, contentHash: "wrong" } } }] }).length, 0);
  const journal = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await journal.start({ sessionId, createdAt: AT, fingerprint: { schemaVersion: "1", providerId: "test", model: "test", toolCatalogHash: "tools", workspaceId: paths.workspaceId } })).ok);
  const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

  for (const currentTurn of [turnId, "unchecked-turn"]) {
    assert.ok((await journal.append({ type: "turn_start", sessionId, turnId: currentTurn, at: AT, payload: {} })).ok);
    for (const item of transcript) assert.ok((await journal.append({ type: "transcript_item", sessionId, turnId: currentTurn, at: AT, payload: json({ ...item, sequence: item.sequence + (currentTurn === turnId ? 0 : 10) }) })).ok);
    assert.ok((await journal.append({ type: "envelope", sessionId, turnId: currentTurn, at: AT, payload: { envelope: json({ ...envelope, turnId: currentTurn }) } })).ok);
    assert.ok((await journal.append({ type: "terminal", sessionId, turnId: currentTurn, at: AT, payload: { reason: currentTurn === turnId ? "completed" : "cancelled" } })).ok);
  }

  await journal.release();
  const facts = createSkillExperienceFile({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled", retention: "segmented" });

  assert.ok(facts.append({ workspaceId: paths.workspaceId, runId: `${sessionId}:${turnId}`, sourceRef: "execution:later-task", episode: episode("later-success", "success"),
    qualification: { kind: "external_check", ref: "execution:check:later-task" },
    usedSkill: { versionId, variantId: draft.variants[0]!.id, contentHash: asset.contentHash } }).ok);
  const reopened = createSkillDailyManagement(ctx), list = await reopened.list();
  assert.ok(list.ok);
  assert.equal(list.skills.length, 1);
  assert.equal(list.skills[0]?.usage.loads, 2);
  assert.equal(list.skills[0]?.usage.successes, 1);
  assert.equal(list.skills[0]?.usage.unknownOutcomes, 1);
  assert.equal(list.skills[0]?.usage.qualifiedRuns, 1);
  const detail = await reopened.show(versionId);
  assert.ok(detail.ok);
  assert.equal(detail.uses[0]?.runId, `${sessionId}:${turnId}`);
  assert.match(detail.content, /retain zero values/);
  assert.equal(detail.uses.find(use => use.runId.endsWith(":unchecked-turn"))?.outcome, "unknown");
  const foreign = createSkillDailyManagement({ ...ctx, cwd: path.join(root, "other-workspace") });

  assert.equal((await foreign.show(versionId)).ok, false);
  assert.equal((await foreign.withdraw(versionId)).ok, false);
  assert.equal(learnedSkillCatalog({ state: loaded.state, contentRoot: ctx.cwd, context: { workspaceId: paths.workspaceId, taskFamily: family } }).catalog?.list().length, 1);
  const withdrawn = await reopened.withdraw(versionId);
  assert.ok(withdrawn.ok);
  assert.equal(withdrawn.status, "withdrawn");
  const after = await createBoardReader(paths.boardRoot).load();
  assert.ok(after.ok);
  assert.equal(learnedSkillCatalog({ state: after.state, contentRoot: ctx.cwd, context: { workspaceId: paths.workspaceId, taskFamily: family } }).catalog, undefined);
  const repeated = await reopened.withdraw(versionId);
  assert.ok(repeated.ok);
  assert.equal(repeated.status, "already_withdrawn");
  const history = await createSkillDailyManagement(ctx).list();
  assert.ok(history.ok);
  assert.equal(history.skills[0]?.status, "retired");
  assert.equal(history.skills[0]?.usage.loads, 2, "withdrawal preserves canonical prior use and immutable content");
  appendFileSync(sessionPath(ctx.homeDir, ctx.env, sessionId), '{"unfinished":');
  assert.equal((await createSkillDailyManagement(ctx).list()).ok, false, "a corrupt journal is unavailable, never an invented zero load count");
  unlinkSync(sessionPath(ctx.homeDir, ctx.env, sessionId));
  assert.equal((await createSkillDailyManagement(ctx).list()).ok, false, "a deleted canonical journal cannot erase a retained qualified usage claim into zero");
});
