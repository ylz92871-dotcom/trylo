import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { SkillExperience } from "./runtime-contract.js";
import { createSkillExperienceFile, SKILL_EXPERIENCES_FILE, SKILL_EXPERIENCES_LOCK } from "./experience-file.js";

function experience(id = "episode-a"): SkillExperience {
  return { workspaceId: "workspace-a", runId: `run:${id}`, sourceRef: `journal:${id}`,
    episode: { id, taskFamily: { id: "ts-unit-fix", intentClass: "repair", checkKind: "unit_test" },
      trajectory: { nodeIds: ["inspect", "check"], stepCount: 2, hadFailureRecovery: false, hadChecks: true },
      outcome: "success", steps: ["inspect input", "check output"], checks: ["assert output"] },
    qualification: { kind: "external_check", ref: `check:${id}` } };
}

function fixture(t: { after(fn: () => void): void }, limits?: { maxBytes?: number; maxRecords?: number; maxRecordBytes?: number }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-skill-experience-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, SKILL_EXPERIENCES_FILE);
  const store = createSkillExperienceFile({ root, workspaceId: "workspace-a", collection: () => "enabled", ...(limits === undefined ? {} : { limits }) });
  return { root, file, store };
}

test("experience append replays exactly once and survives a fresh runtime", t => {
  const fx = fixture(t);

  assert.deepEqual(fx.store.append(experience()), { ok: true, status: "appended" });
  assert.deepEqual(fx.store.append(experience()), { ok: true, status: "duplicate" });
  const restarted = createSkillExperienceFile({ root: fx.root, workspaceId: "workspace-a", collection: () => "enabled" });
  const read = restarted.read("opportunity-1");

  assert.ok(read.ok);
  assert.deepEqual(read.opportunity, { opportunityId: "opportunity-1", workspaceId: "workspace-a", collection: "enabled", experiences: [experience()] });
  const conflict = fx.store.append({ ...experience(), runId: "other-run" });

  assert.equal(conflict.ok, false);

  if (!conflict.ok) assert.equal(conflict.code, "experience_conflict");

  assert.equal(readFileSync(fx.file, "utf8").split("\n").filter(Boolean).length, 1);
});

test("disabled collection does not inspect a corrupt file, parse facts or create paths", t => {
  const fx = fixture(t);

  writeFileSync(fx.file, "private-corrupt-tail", "utf8");
  const root = path.join(fx.root, "never-created");
  const store = createSkillExperienceFile({ root, workspaceId: "workspace-a", collection: () => "disabled" });

  assert.deepEqual(store.append({ rawUserText: "must not be read" }), { ok: true, status: "disabled" });
  const read = store.read("disabled-opportunity");

  assert.ok(read.ok);
  assert.deepEqual(read.opportunity.experiences, []);
  assert.equal(read.opportunity.collection, "disabled");
  assert.equal(existsSync(root), false);
  const corruptStore = createSkillExperienceFile({ root: fx.root, workspaceId: "workspace-a", collection: () => "disabled" });

  assert.equal(corruptStore.read("disabled").ok, true);
});

test("facts reject malformed steps, weak success, forged attribution and foreign workspace", t => {
  const fx = fixture(t), base = experience();
  const invalid: unknown[] = [
    { ...base, episode: { ...base.episode, steps: "not-an-array" } },
    { ...base, qualification: { kind: "execution_failure", ref: "terminal:completed" } },
    { ...base, qualification: { kind: "explicit_correction", ref: "user:silent" } },
    { ...base, usedSkill: { versionId: "v1", variantId: "var1" } },
    { ...base, usedSkill: { versionId: "", variantId: "var1", contentHash: "hash" } },
    { ...base, workspaceId: "workspace-b" },
    { ...base, rawUserText: "must never persist" },
  ];

  for (const raw of invalid) assert.equal(fx.store.append(raw).ok, false);

  assert.equal(existsSync(fx.file), false);
});

test("explicit corrections keep their qualification and scope; failures keep their evidence", t => {
  const fx = fixture(t), base = experience();
  const corrected = { ...base, episode: { ...base.episode, outcome: "failure", failureMode: "wrong order",
    correction: { targetEpisodeIds: ["old-episode"], scope: "condition", reason: "inspect before edit" } },
    qualification: { kind: "explicit_correction", ref: "user:correction" } };

  assert.equal(fx.store.append(corrected).ok, true);
  assert.equal(fx.store.append({ ...corrected, episode: { ...corrected.episode, id: "wrong-qualification" },
    qualification: { kind: "external_check", ref: "test:wrong" } }).ok, false);
  assert.equal(fx.store.append({ ...base, episode: { ...base.episode, id: "failure", outcome: "failure", failureMode: "output mismatch" },
    qualification: { kind: "execution_failure", ref: "tool:error" },
    usedSkill: { versionId: "version-1", variantId: "variant-1", contentHash: "hash-1" } }).ok, true);
  const read = fx.store.read("opportunity-2");

  assert.ok(read.ok);
  assert.equal(read.opportunity.experiences.length, 2);
  assert.equal(read.opportunity.experiences[0]?.episode.correction?.scope, "condition");
  assert.equal(read.opportunity.experiences[1]?.usedSkill?.versionId, "version-1");
});

test("exclusive lock refuses another writer without removing its lock", t => {
  const fx = fixture(t), lock = path.join(fx.root, SKILL_EXPERIENCES_LOCK);

  writeFileSync(lock, "another-writer", "utf8");
  const result = fx.store.append(experience());

  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "experience_locked");

  assert.equal(readFileSync(lock, "utf8"), "another-writer");
  assert.equal(existsSync(fx.file), false);
});

test("corrupt or truncated history fails closed and leaves no writer lock", t => {
  const fx = fixture(t);

  assert.equal(fx.store.append(experience()).ok, true);
  const complete = readFileSync(fx.file, "utf8");

  for (const damaged of [complete.trimEnd(), complete.replace("check output", "skip checks"), "{broken}\n"]) {
    writeFileSync(fx.file, damaged, "utf8");
    assert.equal(fx.store.read("bad").ok, false);
    assert.equal(fx.store.append(experience("new-fact")).ok, false);
    assert.equal(readFileSync(fx.file, "utf8"), damaged);
    assert.equal(existsSync(path.join(fx.root, SKILL_EXPERIENCES_LOCK)), false);
  }
});

test("persisted shape guards reject a valid checksum over malformed attribution", t => {
  const fx = fixture(t), raw = { ...experience(), usedSkill: { versionId: "v1" } };
  const record = { schemaVersion: 1, experience: raw };
  writeFileSync(fx.file, `${canonicalJson({ ...record, checksum: sha256Hex(canonicalJson(record)) })}\n`, "utf8");
  assert.equal(fx.store.read("forged").ok, false);
});

test("capacity is checked before reading or appending an oversized history", t => {
  const fx = fixture(t, { maxRecords: 1 });

  assert.equal(fx.store.append(experience()).ok, true);
  assert.equal(fx.store.append(experience("overflow")).ok, false);
  assert.equal(fx.store.append(experience()).ok, true, "an idempotent replay uses no extra capacity");
  const bytes = createSkillExperienceFile({ root: fx.root, workspaceId: "workspace-a", collection: () => "enabled", limits: { maxBytes: 8 } });

  assert.equal(bytes.read("oversized").ok, false);
  const tiny = createSkillExperienceFile({ root: path.join(fx.root, "tiny"), workspaceId: "workspace-a", collection: () => "enabled", limits: { maxRecordBytes: 8 } });

  assert.equal(tiny.append(experience()).ok, false);
  assert.equal(existsSync(path.join(fx.root, "tiny")), false);
});

test("IO failures are typed and never create an empty successful opportunity", t => {
  const fx = fixture(t);
  mkdirSync(fx.file);
  const read = fx.store.read("io-failed");
  assert.equal(read.ok, false);
  assert.equal(fx.store.append(experience()).ok, false);
  assert.equal(existsSync(path.join(fx.root, SKILL_EXPERIENCES_LOCK)), false);
});

test("segmented retention keeps appending and restores archived corrections across restarts", t => {
  const fx = fixture(t);
  const options = { root: fx.root, workspaceId: "workspace-a", collection: () => "enabled" as const,
    retention: "segmented" as const, limits: { maxRecords: 2 } };
  const store = createSkillExperienceFile(options);

  assert.equal(store.append(experience("old-success")).ok, true);
  const base = experience("old-correction");
  const correction = { ...base, episode: { ...base.episode, outcome: "failure", failureMode: "old path is invalid",
    correction: { targetEpisodeIds: ["old-success"], scope: "condition", reason: "preserve exact decimals" } },
    qualification: { kind: "explicit_correction", ref: "user_explicit:old-correction" } };

  assert.equal(store.append(correction).ok, true);
  const firstSegment = readFileSync(fx.file, "utf8");
  const next = store.append(experience("new-success"));

  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(readFileSync(fx.file, "utf8"), firstSegment, "rolling never rewrites earlier evidence");
  const restarted = createSkillExperienceFile(options);
  const loaded = restarted.read("after-restart");
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.opportunity.experiences.map(fact => fact.episode.id), ["old-success", "old-correction", "new-success"]);
  assert.equal(restarted.append(experience("old-success")).ok, true);
  assert.equal(restarted.append({ ...experience("old-success"), runId: "conflicting" }).ok, false);
  assert.equal(createSkillExperienceFile({ root: fx.root, workspaceId: "workspace-a", collection: () => "enabled" }).read("legacy-reader").ok, false,
    "a legacy reader must not silently ignore the continuation segments");
  writeFileSync(fx.file, firstSegment.replace("inspect input", "inspect changed input"), "utf8");
  assert.equal(restarted.read("damaged-source").ok, false);
  assert.equal(restarted.append(experience("after-corruption")).ok, false);
});
