import assert from "node:assert/strict";
import test from "node:test";
import { hermesSkillRead, hermesSkillReadName } from "./skill-read.js";
import { skillExperience } from "./experience.js";
import { contentHashOf } from "../../../control/hash.js";
import type { TranscriptItem } from "../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../protocol/envelope.js";

const name = "mcp__trylo-hermes-capabilities__skill_view";

test("only native fixed tool identities count in history; a real mounted profile may attest its exact custom namespace", () => {
  const output = JSON.stringify({ success: true, name: "resolved", content: "Instructions" });

  for (const tool of ["skill_view", name, "mcp__trylo-hermes-learning__skill_view", "mcp__trylo-hermes-skills__skill_view"]) {
    assert.deepEqual(hermesSkillRead({ name: tool, arguments: { name: "alias" } }, output), { name: "resolved", contentHash: contentHashOf("Instructions") });
  }

  const custom = { name: "mcp__actual-mounted-profile__skill_view", arguments: { name: "alias" } };

  assert.equal(hermesSkillRead(custom, output), undefined);
  assert.equal(hermesSkillReadName(custom, output, "actual-mounted-profile"), "resolved");
  assert.equal(hermesSkillReadName(custom, output, "different-profile"), undefined);

  for (const tool of ["mcp__other-library__skill_view", "mcp__hermes__skill_view", "other__skill_view", "prefix_skill_view"]) {
    assert.equal(hermesSkillRead({ name: tool, arguments: { name: "alias" } }, output), undefined);
  }
});

test("native main instruction reads share one canonical-name interpretation", () => {
  const output = JSON.stringify({ success: true, name: "resolved-procedure", content: "Instructions" });

  for (const args of [{ name: "alias" }, { name: "alias", file_path: null }, { name: "alias", file_path: "" }, { name: "alias", file_path: "SKILL.md" }]) {
    assert.equal(hermesSkillReadName({ name, arguments: args }, output), "resolved-procedure");
  }

  assert.equal(hermesSkillReadName({ name, arguments: { name: "alias", file_path: "references/check.md" } }, output), undefined);

  for (const body of [{ success: false, name: "alias", content: "error" }, { success: true, name: "alias" }, { success: true, content: "missing identity" }]) {
    assert.equal(hermesSkillReadName({ name, arguments: { name: "alias" } }, JSON.stringify(body)), undefined);
  }
});

test("later experience retains the native loaded identity beside a new-turn correction", () => {
  const experience = skillExperience([
    { kind: "tool_call", sequence: 0, toolCallId: "load", name, arguments: { name: "alias", file_path: null } },
    { kind: "tool_result", sequence: 1, toolCallId: "load", name, output: JSON.stringify({ success: true, name: "resolved-procedure", content: "Instructions" }),
      outcome: "succeeded", truncated: false },
    { kind: "user", sequence: 2, text: "The earlier procedure missed the empty case." },
  ]);

  assert.deepEqual(experience.loadedSkills, ["resolved-procedure"]);
  assert.deepEqual(experience.skillReads, [{ name: "resolved-procedure", contentHash: contentHashOf("Instructions"), toolCallId: "load", sequence: 1 }]);
  assert.match(JSON.stringify(experience.messages), /earlier procedure missed the empty case/);
});

test("the same native skill name retains distinct facts for distinct full instruction contents", () => {
  const call = { name, arguments: { name: "alias" } };
  const before = hermesSkillRead(call, JSON.stringify({ success: true, name: "procedure", content: "Handle normal cases." }));
  const after = hermesSkillRead(call, JSON.stringify({ success: true, name: "procedure", content: "Handle normal and empty cases." }));
  assert.ok(before);
  assert.ok(after);
  assert.equal(before.name, after.name);
  assert.notEqual(before.contentHash, after.contentHash);
  assert.equal(hermesSkillReadName(call, JSON.stringify({ success: true, name: "procedure", content: "Handle normal cases." })), before.name);
});

test("read facts hash the complete payload before transport compaction and reject flagged partial reads", () => {
  const instructions = "Complete instructions. ".repeat(600);
  const transcript: TranscriptItem[] = [
    { kind: "tool_call", sequence: 0, toolCallId: "complete", name, arguments: { name: "procedure" } },
    { kind: "tool_result", sequence: 1, toolCallId: "complete", name, output: JSON.stringify({ success: true, name: "procedure", content: instructions }),
      outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 2, toolCallId: "partial", name, arguments: { name: "procedure" } },
    { kind: "tool_result", sequence: 3, toolCallId: "partial", name, output: JSON.stringify({ success: true, name: "procedure", content: "partial" }),
      outcome: "succeeded", truncated: true },
  ];
  const experience = skillExperience(transcript);

  assert.deepEqual(experience.skillReads, [{ name: "procedure", contentHash: contentHashOf(instructions), toolCallId: "complete", sequence: 1 }]);
  assert.ok(JSON.stringify(experience.messages).length < JSON.stringify(transcript).length);
});

test("read facts retain a bounded recent causal window without copying instruction bodies", () => {
  const transcript: TranscriptItem[] = Array.from({ length: 40 }, (_, i) => [
    { kind: "tool_call" as const, sequence: i * 2, toolCallId: `load-${i}`, name, arguments: { name: "procedure" } },
    { kind: "tool_result" as const, sequence: i * 2 + 1, toolCallId: `load-${i}`, name,
      output: JSON.stringify({ success: true, name: "procedure", content: `instruction-${i}` }), outcome: "succeeded" as const, truncated: false },
  ]).flat();
  const experience = skillExperience(transcript);

  assert.ok(Array.isArray(experience.skillReads));
  assert.equal(experience.skillReads.length, 32);
  assert.equal(experience.omittedSkillReads, 8);
  assert.deepEqual(experience.skillReads[0], { name: "procedure", contentHash: contentHashOf("instruction-8"), toolCallId: "load-8", sequence: 17 });
  assert.doesNotMatch(JSON.stringify(experience.skillReads), /instruction-/);
});

test("reused provider call ids preserve each native read and later patch's own arguments", () => {
  const native = (skill: string, content: string) => JSON.stringify({ success: true, name: skill, content });
  const patch = "mcp__trylo-hermes-capabilities__skill_propose";
  const experience = skillExperience([
    { kind: "tool_call", sequence: 0, toolCallId: "read-reused", name, arguments: { name: "alias-a" } },
    { kind: "tool_result", sequence: 1, toolCallId: "read-reused", name, output: native("A", "A instructions"), outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 2, toolCallId: "read-reused", name, arguments: { name: "alias-b", file_path: "SKILL.md" } },
    { kind: "tool_result", sequence: 3, toolCallId: "read-reused", name, output: native("B", "B instructions"), outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 4, toolCallId: "mixed-reused", name, arguments: { name: "alias-c" } },
    { kind: "tool_result", sequence: 5, toolCallId: "mixed-reused", name, output: native("C", "C instructions"), outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 6, toolCallId: "mixed-reused", name: patch, arguments: { action: "patch", name: "C", old_string: "old", new_string: "new" } },
    { kind: "tool_result", sequence: 7, toolCallId: "mixed-reused", name: patch, output: "Pending revision", outcome: "succeeded", truncated: false },
  ]);

  assert.deepEqual(experience.loadedSkills, ["A", "B", "C"]);
  assert.deepEqual(experience.skillReads, [
    { name: "A", contentHash: contentHashOf("A instructions"), toolCallId: "read-reused", sequence: 1 },
    { name: "B", contentHash: contentHashOf("B instructions"), toolCallId: "read-reused", sequence: 3 },
    { name: "C", contentHash: contentHashOf("C instructions"), toolCallId: "mixed-reused", sequence: 5 },
  ]);
  assert.ok(Array.isArray(experience.messages));
  const messages = experience.messages.map(value => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as JsonObject;
  });

  assert.deepEqual(messages.map(item => item.sequence), [0, 2, 4, 6]);
  assert.deepEqual(messages.map(item => item.arguments), [JSON.stringify({ name: "alias-a" }), JSON.stringify({ name: "alias-b", file_path: "SKILL.md" }),
    JSON.stringify({ name: "alias-c" }), JSON.stringify({ action: "patch", name: "C", old_string: "old", new_string: "new" })]);
  assert.deepEqual(messages.map(item => item.name), [name, name, name, patch]);
});

test("an orphan result cannot borrow a future call or a differently named earlier operation", () => {
  const output = JSON.stringify({ success: true, name: "must-not-be-loaded", content: "No paired instruction load" });
  const experience = skillExperience([
    { kind: "tool_result", sequence: 0, toolCallId: "future", name, output, outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 1, toolCallId: "future", name, arguments: { name: "future-only" } },
    { kind: "tool_call", sequence: 2, toolCallId: "mismatch", name: "read_file", arguments: { path: "issued.txt" } },
    { kind: "tool_result", sequence: 3, toolCallId: "mismatch", name, output, outcome: "succeeded", truncated: false },
  ]);

  assert.deepEqual(experience.messages, []);
  assert.deepEqual(experience.loadedSkills, []);
  assert.deepEqual(experience.skillReads, []);
});
