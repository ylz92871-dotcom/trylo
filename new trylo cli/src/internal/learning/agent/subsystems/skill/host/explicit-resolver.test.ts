import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { contentHashOf } from "../../../../control/hash.js";
import type { SkillCatalogPort, SkillDescriptor } from "../../../../../ports/skills.js";
import { createHermesExplicitResolver } from "./explicit-resolver.js";

const root = path.resolve("native-synthetic-skill");
const body = "Follow the selected procedure.\n!`do-not-execute`";
const content = `---\nname: native-name\nallowed-tools: ['terminal*', 'Bash(rm:*)']\n---\n${body}`;
const native = (requestedName = "category/native-name") => ({ requestedName, name: "native-name", description: "Synthetic procedure",
  skillRoot: root, path: path.join(root, "SKILL.md"), body, content,
  userInvocable: false, disableModelInvocation: true, forkExecution: false });
const options = { pythonBinary: "unused", capabilitiesDir: "unused", hermesHome: "unused", env: {} };
const descriptor: SkillDescriptor = { name: "local", description: "Local first", source: "project", skillRoot: root,
  path: path.join(root, "SKILL.md"), contentHash: "local-hash", body: "LOCAL", userInvocable: true, disableModelInvocation: false, forkExecution: false };
const local: SkillCatalogPort = { list: () => [descriptor], load: name => name === "local"
  ? { kind: "loaded", skill: { descriptor, content: "LOCAL" } } : { kind: "unknown_skill", name } };

test("only locally missing explicit names are requested once and native content stays frozen", async () => {
  const observed: string[][] = [];
  const reply = native();
  const resolver = createHermesExplicitResolver({ ...options, read: async names => {
    observed.push([...names]);
    return { success: true, skills: [reply] };
  } });
  const result = await resolver.resolveSelected({ names: ["local", "category/native-name", "category/native-name"], localCatalog: local });

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [["category/native-name"]]);

  if (!result.ok) return;

  reply.content = "changed after process result";
  const loaded = result.catalog.load("category/native-name", undefined);

  assert.equal(loaded.kind, "loaded");

  if (loaded.kind !== "loaded") return;

  assert.equal(loaded.skill.content, content);
  assert.equal(loaded.skill.descriptor.contentHash, contentHashOf(content));
  assert.equal(loaded.skill.descriptor.allowedTools, undefined);
  assert.equal(loaded.skill.descriptor.userInvocable, false);
  assert.equal(loaded.skill.descriptor.disableModelInvocation, true);
  assert.equal(loaded.skill.descriptor.source, "additional");
  assert.deepEqual(result.provided, [{ origin: "hermes", requestedName: "category/native-name", name: "native-name", contentHash: contentHashOf(content) }]);
  assert.equal(result.catalog.load("unselected", undefined).kind, "unknown_skill");
  assert.equal(local.list().length, 1);
  assert.equal(local.load("category/native-name", undefined).kind, "unknown_skill");
});

test("locally known selections and empty selections do not initialize native resources", async () => {
  const resolver = createHermesExplicitResolver({ ...options, read: async () => { throw new Error("unexpected native read"); } });
  for (const names of [[], ["local"]]) {
    const result = await resolver.resolveSelected({ names, localCatalog: local });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.provided, []);
      assert.equal(result.catalog.load("local", undefined).kind, "loaded");
    }
  }
});

test("native refusals and malformed, missing or unexpected batch entries fail closed without raw errors", async () => {
  for (const reply of [
    { success: false, code: "hermes_explicit_not_available", requestedName: "selected", error: "PRIVATE_DETAIL" },
    { success: false, code: "PRIVATE_DETAIL", error: "PRIVATE_DETAIL" },
    { success: true, skills: [] },
    { success: true, skills: [native("unselected")] },
    { success: true, skills: [{ ...native("selected"), skillRoot: "relative" }] },
    { success: true, skills: [{ ...native("selected"), userInvocable: "false" }] },
    { success: true, skills: [native("selected"), native("selected")] },
  ]) {
    const result = await createHermesExplicitResolver({ ...options, read: async () => reply }).resolveSelected({ names: ["selected"] });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_DETAIL"), false);
  }
});

test("cancellation before and after native IO never returns a usable overlay", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const resolver = createHermesExplicitResolver({ ...options, read: async () => { throw new Error("unexpected native read"); } });
  assert.deepEqual(await resolver.resolveSelected({ names: ["selected"], signal: cancelled.signal }), { ok: false, code: "cancelled" });
  const during = new AbortController();
  const late = createHermesExplicitResolver({ ...options, read: async () => {
    during.abort();
    return { success: true, skills: [native("selected")] };
  } });
  assert.deepEqual(await late.resolveSelected({ names: ["selected"], signal: during.signal }), { ok: false, code: "cancelled" });
});

test("fork metadata reaches the existing Team binding gate without becoming an implicit fork", async () => {
  const result = await createHermesExplicitResolver({ ...options, read: async () => ({ success: true, skills: [{ ...native("selected"), forkExecution: true }] }) })
    .resolveSelected({ names: ["selected"] });

  assert.equal(result.ok, true);

  if (result.ok) {
    const loaded = result.catalog.load("selected", undefined);
    assert.equal(loaded.kind === "loaded" && loaded.skill.descriptor.forkExecution, true);
  }
});
