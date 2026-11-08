import assert from "node:assert/strict";
import test from "node:test";
import { submitDraftCommand } from "../shared/board-command.js";
import type { SkillDraft, SkillEpisode } from "./types.js";
import { induceSkill, renderSkillVariantMarkdown } from "./inducer.js";
import { parseSkillDraft } from "./parse-draft.js";
import { parseSkillEpisode } from "./parse-episode.js";
import { sameSkillTaskFamily } from "./conditions.js";

const family = { id: "convert-report", intentClass: "convert_report", checkKind: "acceptance" as const, checkSchema: "decimal-v1" };

function episode(id: string, outcome: "success" | "failure" = "success"): SkillEpisode {
  return {
    id, taskFamily: family, outcome, steps: ["parse typed structure", "check decimal strings"],
    checks: ["external decimal checker"],
    trajectory: { nodeIds: ["parse", "check"], stepCount: 2, hadChecks: true, hadFailureRecovery: false },
    ...(outcome === "failure" ? { failureMode: "numeric coercion changes exact decimals" } : {}),
  };
}

function draft(): SkillDraft {
  const result = induceSkill([episode("a"), episode("b"), episode("f", "failure")]);
  assert.equal(result.kind, "draft");
  if (result.kind !== "draft") { throw new Error("fixture did not induce"); }
  return result.draft;
}

test("conditioned draft roundtrip checks provenance and permits runtime-bound ledger scope", () => {
  const original = draft();
  const bound = { ...original, id: "workspace-bound-id", scope: { kind: "task_family", id: "workspace-hash/convert-report" }, command: submitDraftCommand("skill", "workspace-bound-id") };
  const parsed = parseSkillDraft(JSON.parse(JSON.stringify(bound)));

  assert.equal(parsed.ok, true);

  if (parsed.ok) { assert.deepEqual(parsed.value, bound); }

  assert.equal(parseSkillDraft({ ...original, variants: undefined }).ok, false);
  assert.equal(parseSkillDraft({ ...original, steps: ["unattributed", "instructions"] }).ok, false);
  assert.equal(parseSkillDraft({ ...original, variants: [{ ...original.variants[0], supportEpisodeIds: ["invented"] }] }).ok, false);
  assert.equal(parseSkillDraft({ ...original, variants: [{ ...original.variants[0], stepEvidence: original.variants[0]!.stepEvidence.map((row) => ({ ...row, episodeIds: [] })) }] }).ok, false);
  assert.equal(parseSkillDraft({ ...original, variants: [{ ...original.variants[0], checks: ["download package"] }] }).ok, false);
});

test("exact conditions preserve multiple complete methods and selected rendering omits other branches", () => {
  const other = { ...episode("other"), taskFamily: { ...family, checkSchema: "integer-v1" }, steps: ["parse integer structure", "check integers"] };
  const result = induceSkill([episode("a"), other, episode("f", "failure")]);

  assert.equal(result.kind, "draft");

  if (result.kind !== "draft") { return; }

  assert.equal(result.draft.variants.length, 2);
  const variant = result.draft.variants.find((entry) => entry.taskFamily.checkSchema === "decimal-v1");

  assert.ok(variant);
  assert.deepEqual(variant.stepEvidence[0]?.episodeIds, ["a"]);
  assert.deepEqual(variant.failureLessons[0]?.episodeIds, ["f"]);
  assert.doesNotMatch(renderSkillVariantMarkdown(result.draft, variant), /parse integer structure|check integers/);
  assert.equal(sameSkillTaskFamily(family, { ...family, checkSchema: "integer-v1" }), false);
  assert.equal(sameSkillTaskFamily(family, { id: family.id, intentClass: family.intentClass, checkKind: family.checkKind }), false);
  assert.equal(parseSkillDraft(result.draft).ok, true);
});

test("task exceptions do not suppress future use, condition corrections need explicit independent revalidation", () => {
  const correction = { ...episode("correction", "failure"), correction: { targetEpisodeIds: ["a"], scope: "task" as const, reason: "one task exception" } };
  const taskException = induceSkill([episode("a"), episode("b"), correction]);

  assert.equal(taskException.kind, "draft");

  if (taskException.kind === "draft") {
    assert.doesNotMatch(renderSkillVariantMarkdown(taskException.draft, taskException.draft.variants[0]!), /one task exception|numeric coercion/);
  }

  const scoped = { ...correction, correction: { ...correction.correction, scope: "condition" as const } };

  assert.equal(induceSkill([episode("a"), episode("b"), scoped]).kind, "failure");
  const revalidated = { ...episode("new-pass"), validatedAfterCorrectionIds: ["correction"] };
  const result = induceSkill([episode("a"), episode("b"), scoped, revalidated]);

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.deepEqual(result.draft.variants[0]?.supportEpisodeIds, ["new-pass"]);
    assert.deepEqual(result.draft.variants[0]?.correctionRefs, ["correction"]);
    assert.equal(parseSkillDraft(result.draft).ok, true);
  }

  assert.equal(parseSkillEpisode({ ...scoped, outcome: "success" }).ok, false);
  assert.equal(parseSkillEpisode({ ...scoped, correction: { ...scoped.correction, scope: "global" } }).ok, false);
});

