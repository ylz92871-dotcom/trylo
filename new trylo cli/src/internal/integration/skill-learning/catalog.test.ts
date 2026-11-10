import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSkillTools } from "../../adapters/tools/skill/index.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { induceSkill, type SkillDraft, type SkillEpisode } from "../../learning/domains/skill/index.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";
import { skillsPortFor } from "../../surface/cli/skills-wiring.js";
import { decodeLearnedSkillContent, learnedSkillCatalog } from "./catalog.js";
import type { LearnedSkillContent, LearnedSkillContext, LearnedSkillLoad } from "./contracts.js";
import { projectionScope } from "../content/scope.js";

const FAMILY: TaskFamily = { id: "unit-regression", intentClass: "fix_regression", checkKind: "unit_test",
  language: "typescript", repoKind: "library", checkSchema: "node-test-v1" };
const CONTEXT: LearnedSkillContext = { workspaceId: "project-a", taskFamily: FAMILY };

function episode(id: string, outcome: "success" | "failure", family: TaskFamily = FAMILY): SkillEpisode {
  const steps = family.language === "python" ? ["run pytest", "repair python source", "re-run pytest"]
    : ["reproduce failure", "repair production code", "run regression"];
  return { id, outcome, taskFamily: family,
    trajectory: { nodeIds: ["repro", "fix", "check"], stepCount: 3, hadChecks: true, hadFailureRecovery: false },
    steps, checks: [family.language === "python" ? "pytest exits zero" : "regression exits zero"],
    ...(outcome === "failure" ? { failureMode: family.language === "python" ? "python-only failure" : "editing tests hides defect" } : {}) };
}

function draft(): SkillDraft {
  const python: TaskFamily = { ...FAMILY, language: "python" };
  const result = induceSkill([episode("ts-s1", "success"), episode("ts-s2", "success"), episode("ts-f1", "failure"),
    episode("py-s1", "success", python), episode("py-f1", "failure", python)]);
  assert.equal(result.kind, "draft");
  if (result.kind !== "draft") throw new Error("skill catalog fixture cannot be induced");
  return result.draft;
}

function board(): BoardState {
  const skill = draft();
  const content: LearnedSkillContent = { kind: "learned_skill", schemaVersion: 1, workspaceId: "project-a",
    experienceDigest: "experience-1", sourceOpportunityId: "opportunity-1", draft: skill };

  return { ...emptyBoardState(),
    proposals: [{ proposalId: skill.id, domain: "skill", scope: projectionScope(skill.scope), assetKind: "skill",
      candidateRef: "skill-candidate", hypothesis: "repair regressions without hiding defects", observationRefs: skill.provenance.observationRefs,
      risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred", lifecycle: "shadow" }],
    assets: [{ versionId: "skill-v1", kind: "skill", schemaVersion: 1, content, contentHash: contentHashOf(content),
      source: "inferred", scope: projectionScope(skill.scope), createdAt: "2026-11-03T00:00:00.000Z", createdFromProposalId: skill.id }],
    activations: [{ activationId: "act-skill", scope: projectionScope(skill.scope), assetKind: "skill", pointer: "shadow",
      versionId: "skill-v1", boardSequence: 4, generation: 1 }] };
}

test("a Board skill reaches the existing CLI catalog and skill tool; only load records exposure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-learned-skill-"));
  try {
    const loads: LearnedSkillLoad[] = [];
    const wired = skillsPortFor(root, { TRYLO_HOME: root }, root, { state: board(), context: CONTEXT,
      onLoaded: load => loads.push(load) });

    assert.deepEqual(wired.problems, []);
    const catalog = wired.catalog;

    assert.ok(catalog);
    // The bundled browser-media-creation skill shares this catalog and lists
    // before the Board entries, so the learned skill is selected by origin
    // rather than by position. This fixture's temp roots hold no other skill.
    const descriptor = catalog.list().find(entry => entry.source !== "builtin");

    assert.ok(descriptor);
    assert.equal(loads.length, 0);
    const tools = createSkillTools(catalog);

    tools.snapshot();
    assert.equal(loads.length, 0);
    const result = await tools.execute({ name: "skill", toolCallId: "call-1", arguments: { skill: descriptor.name } }, new AbortController().signal);

    assert.equal(result.outcome, "result");

    if (result.outcome !== "result") return;

    assert.match(result.output, /repair production code/);
    assert.match(result.output, /Version: skill-v1; content hash:/);
    assert.match(result.output, /editing tests hides defect/);
    assert.doesNotMatch(result.output, /repair python source|python-only failure|pytest exits zero/);
    assert.equal(loads.length, 1);
    assert.equal(loads[0]?.versionId, "skill-v1");
    assert.equal(loads[0]?.contentHash, descriptor.contentHash);
    assert.equal(catalog.load("unknown", undefined).kind, "unknown_skill");
    assert.equal(loads.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact task facts select another learned variant without leaking the preferred instructions", () => {
  const selected = learnedSkillCatalog({ state: board(), contentRoot: "D:/workspace", context: {
    ...CONTEXT, taskFamily: { ...FAMILY, language: "python" } } });
  const descriptor = selected.catalog?.list()[0];

  assert.ok(descriptor);
  const result = selected.catalog?.load(descriptor.name, undefined);

  assert.equal(result?.kind, "loaded");

  if (result?.kind !== "loaded") return;

  assert.match(result.skill.content, /repair python source/);
  assert.doesNotMatch(result.skill.content, /repair production code|editing tests hides defect/);
});

test("surface similarity cannot broaden a learned skill across workspace or missing conditions", () => {
  const mismatches: LearnedSkillContext[] = [
    { ...CONTEXT, workspaceId: "project-b" },
    ...(["id", "intentClass", "checkKind", "language", "repoKind", "checkSchema"] as const).map(key => ({
      ...CONTEXT, taskFamily: { ...FAMILY, [key]: key === "checkKind" ? "compile" : "different" } as TaskFamily,
    })),
    { ...CONTEXT, taskFamily: { id: FAMILY.id, intentClass: FAMILY.intentClass, checkKind: FAMILY.checkKind } },
  ];
  for (const context of mismatches) {
    const result = learnedSkillCatalog({ state: board(), contentRoot: "D:/workspace", context });
    assert.equal(result.catalog, undefined, JSON.stringify(context));
  }
});

test("unverified, suspended, tampered, tombstoned and legacy content stays unavailable", () => {
  const state = board();
  const asset = state.assets[0]!;
  const proposal = state.proposals[0]!;
  const activation = state.activations[0]!;
  const cases: BoardState[] = [
    { ...state, activations: [] },
    { ...state, activations: [{ ...activation, pointer: "suspended" }] },
    { ...state, activations: [{ ...activation, breaker: { open: true, reason: "failure", consecutiveFailures: 1 } }] },
    { ...state, proposals: [{ ...proposal, lifecycle: "draft" }] },
    { ...state, assets: [{ ...asset, contentHash: "tampered" }] },
    { ...state, assets: [{ ...asset, schemaVersion: 2 }] },
    { ...state, assets: [{ ...asset, content: draft(), contentHash: contentHashOf(draft()) }] },
    { ...state, tombstones: [{ entityId: asset.versionId, entityType: "asset", boardSequence: 5, reason: "withdrawn" }] },
  ];

  for (const candidate of cases) {
    assert.equal(learnedSkillCatalog({ state: candidate, contentRoot: "D:/workspace", context: CONTEXT }).catalog, undefined);
  }
});

test("content decoder refuses missing version-1 provenance and malformed drafts", () => {
  const content = board().assets[0]!.content;

  assert.ok(decodeLearnedSkillContent(content));
  assert.equal(decodeLearnedSkillContent(null), undefined);
  assert.equal(decodeLearnedSkillContent({ kind: "learned_skill", schemaVersion: 1 }), undefined);
  const item = decodeLearnedSkillContent(content)!;

  for (const patch of [{ experienceDigest: "" }, { sourceOpportunityId: "" }, { schemaVersion: 2 },
    { draft: { ...item.draft, permissionClaim: true } }, { draft: { ...item.draft, variants: [] } }]) {
    assert.equal(decodeLearnedSkillContent({ ...item, ...patch }), undefined);
  }
});

test("bounded proof window metadata is optional but must agree with immutable draft provenance", () => {
  const content = decodeLearnedSkillContent(board().assets[0]!.content)!;
  const selectedEpisodeIds = content.draft.provenance.observationRefs;
  const sourceWindow = { inputDigest: content.experienceDigest, selectedEpisodeIds,
    omittedCount: 300, sourceRefs: selectedEpisodeIds.map(id => `execution:${id}`) };

  assert.ok(decodeLearnedSkillContent({ ...content, sourceWindow }));

  for (const patch of [{ inputDigest: "different-history" }, { selectedEpisodeIds: selectedEpisodeIds.slice(1) },
    { omittedCount: -1 }, { sourceRefs: [] }]) {
    assert.equal(decodeLearnedSkillContent({ ...content, sourceWindow: { ...sourceWindow, ...patch } }), undefined);
  }
});

test("rejecting a shadow proposal withdraws the old catalog entry without reporting corruption", () => {
  const original = board();
  const before = learnedSkillCatalog({ state: original, contentRoot: "D:/workspace", context: CONTEXT });
  const name = before.catalog?.list()[0]?.name;

  assert.ok(name);
  const proposalId = original.proposals[0]!.proposalId;
  const rejected = reduce(original, { type: "reject", commandId: "correction-withdrawal", proposalId,
    issuedAt: "2026-11-03T01:00:00.000Z", reason: "explicit correction disproves trial" });

  assert.equal(rejected.ok, true);

  if (!rejected.ok) return;

  const after = learnedSkillCatalog({ state: rejected.state, contentRoot: "D:/workspace", context: CONTEXT });

  assert.equal(after.catalog?.load(name, undefined).kind, undefined);
  assert.deepEqual(after.problems, []);

  for (const lifecycle of ["suspended", "retired"] as const) {
    const withdrawn = { ...original, proposals: [{ ...original.proposals[0]!, lifecycle }] };
    const result = learnedSkillCatalog({ state: withdrawn, contentRoot: "D:/workspace", context: CONTEXT });
    assert.equal(result.catalog, undefined);
    assert.deepEqual(result.problems, []);
  }

  const inconsistent = { ...original, proposals: [{ ...original.proposals[0]!, lifecycle: "draft" as const }] };

  assert.equal(learnedSkillCatalog({ state: inconsistent, contentRoot: "D:/workspace", context: CONTEXT }).problems.length, 1);
});
