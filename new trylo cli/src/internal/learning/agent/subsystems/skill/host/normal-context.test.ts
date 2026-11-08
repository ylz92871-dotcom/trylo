import assert from "node:assert/strict";
import test from "node:test";
import type { HermesToolProfile } from "./client.js";
import { normalContextPrompt } from "./normal-context.js";

const profile: HermesToolProfile = { name: "test-hermes", command: "python", args: [], env: {},
  allowedTools: ["mcp__test-hermes__skills_list", "mcp__test-hermes__skill_view"] };

function index(skills: string) {
  return "## Skills (mandatory)\nBefore replying, scan the skills below. You MUST load relevant skills with skill_view(name).\n"
    + "If a skill has issues, fix it with skill_manage(action='patch').\n"
    + `<available_skills>\n${skills}\n</available_skills>\nOnly proceed without loading a skill if none are relevant.`;
}

test("normal context retains upstream discovery instructions and metadata while addressing mounted tools", () => {
  const metadata = "  code:\n    - release: Use skill_view(name) to inspect release material.";
  const prompt = normalContextPrompt(index(metadata), profile);

  assert.match(prompt, /MUST load relevant skills with mcp__test-hermes__skill_view\(name\)/);
  assert.ok(prompt.includes(metadata), "metadata belongs to Hermes and must not be rewritten");
  assert.doesNotMatch(prompt, /fix it with skill_manage/);
  assert.match(prompt, /skill learning subsystem can propose a revision/);
  assert.match(prompt, /does not grant tool permissions/);
  assert.match(prompt, /Read linked scripts or references with mcp__test-hermes__skill_view\(name, file_path\)/);
});

test("a bounded index has complete lines and an explicit route to the complete native catalog", () => {
  const prompt = normalContextPrompt(index(Array.from({ length: 100 }, (_, i) => `    - skill-${i}: ${"x".repeat(100)}`).join("\n")), profile,
    { maxChars: 1300 });

  assert.ok(prompt.length <= 1300);
  assert.match(prompt, /Skill index shortened/);
  assert.match(prompt, /Call mcp__test-hermes__skills_list/);
  assert.match(prompt, /<available_skills>[\s\S]*<\/available_skills>/);
  assert.ok(prompt.split("\n").filter(line => line.startsWith("    -")).every(line => line.endsWith("x".repeat(100))));
});

test("empty catalogs, insufficient budget and an absent view tool cannot advertise an unusable skill index", () => {
  assert.equal(normalContextPrompt("", profile), "");
  assert.equal(normalContextPrompt(index("    - one"), profile, { maxChars: 1 }), "");
  assert.equal(normalContextPrompt(index("    - one"), { ...profile, allowedTools: [] }), "");
  assert.equal(normalContextPrompt(index("    - one"), profile, { mountedTools: ["read_file"] }), "");
  assert.equal(normalContextPrompt(index("    - one"), profile, { mountedTools: [profile.allowedTools[1]!] }), "");
  assert.ok(normalContextPrompt(index("    - one"), profile, { mountedTools: profile.allowedTools }).includes("    - one"));
  assert.throws(() => normalContextPrompt("not an upstream skill index", profile), /hermes_context_shape_invalid/);
});

test("an upstream names-only index can retain late skill names within the same host budget", () => {
  const names = Array.from({ length: 70 }, (_, i) => `procedure-${String(i).padStart(2, "0")}`);
  // This fixture needs 2026 characters with the mandatory authority and
  // compaction guidance. Keep one fixed budget for both native presentations.
  const maxChars = 2100;
  const full = normalContextPrompt(index(names.map(name => `    - ${name}: ${"description ".repeat(8)}`).join("\n")), profile, { maxChars });

  assert.doesNotMatch(full, /procedure-69/);
  const compact = normalContextPrompt(index(`  procedures [names only]: ${names.join(", ")}`), profile, { maxChars });

  assert.ok(compact.length <= maxChars);
  assert.match(compact, /procedure-69/);
  assert.doesNotMatch(compact, /Skill index shortened/);
});
