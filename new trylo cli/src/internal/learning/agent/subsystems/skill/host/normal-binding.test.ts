import assert from "node:assert/strict";
import { test } from "node:test";
import { bindHermesNormalContext } from "./normal-binding.js";
import type { HermesToolProfile } from "./client.js";

const profile: HermesToolProfile = { name: "normal", command: "python", args: [], env: {},
  allowedTools: ["mcp__normal__skills_list", "mcp__normal__skill_view"] };
const nativePrompt = "Load with skill_view(name).\n<available_skills>\n  - current: current procedure\n</available_skills>";

test("mounted binding forwards exact visibility only when both native read tools survived selection", async () => {
  let calls = 0;
  const binding = bindHermesNormalContext(profile, { async context(input, signal) {
    calls++;
    assert.deepEqual(input, { maxPromptChars: 15_000, availableTools: [...profile.allowedTools, "run_shell"], availableToolsets: [] });
    assert.equal(signal, controller.signal);
    return { ok: true, prompt: nativePrompt, upstreamPromptHash: "sha256:" + "0".repeat(64) };
  }, recordView: async () => ({ ok: true }) }, () => { throw new Error("unexpected warning"); });
  const controller = new AbortController();

  assert.equal(await binding.promptForTools(["read_file"], controller.signal), "");
  assert.equal(calls, 0);
  assert.match(await binding.promptForTools([...profile.allowedTools, "run_shell"], controller.signal), /mcp__normal__skill_view\(name\)/);
  assert.equal(calls, 1);
});

test("native context or formatting failures degrade explicitly and cancellation never emits raw diagnostics", async () => {
  const warnings: string[] = [];
  const unavailable = bindHermesNormalContext(profile, { context: async () => { throw new Error("PRIVATE_DEPENDENCY_TEXT"); },
    recordView: async () => ({ ok: true }) }, code => warnings.push(code));

  assert.equal(await unavailable.promptForTools(profile.allowedTools), "");
  const malformed = bindHermesNormalContext(profile, { context: async () => ({ ok: true, prompt: "invalid native shape",
    upstreamPromptHash: "sha256:" + "0".repeat(64) }), recordView: async () => ({ ok: true }) }, code => warnings.push(code));

  assert.equal(await malformed.promptForTools(profile.allowedTools), "");
  const cancel = new AbortController();
  cancel.abort();
  assert.equal(await unavailable.promptForTools(profile.allowedTools, cancel.signal), "");
  assert.deepEqual(warnings, ["hermes_normal_context_unavailable", "hermes_normal_context_unavailable"]);
});
