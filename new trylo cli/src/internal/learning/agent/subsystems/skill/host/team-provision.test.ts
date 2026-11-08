import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillCatalogPort, SkillDescriptor } from "../../../../../ports/skills.js";
import type { ChildRequestDispatch } from "../../../../../subagent/request-dispatched.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createTeamSkillProvisionObserver } from "./team-provision.js";

const content = "---\nname: official-name\n---\nPRIVATE_SKILL_BODY";
const hash = contentHashOf(content);
const injectedText = `Selected member skill: selected-alias\n${content}`;
const descriptor: SkillDescriptor = { name: "official-name", description: "native", source: "additional", path: "D:/private/native/SKILL.md",
  skillRoot: "D:/private/native", contentHash: hash, body: "PRIVATE_SKILL_BODY", userInvocable: true, disableModelInvocation: false, forkExecution: false };
const catalog: SkillCatalogPort = { list: () => [descriptor], load: name => name === "selected-alias"
  ? { kind: "loaded", skill: { descriptor, content } } : { kind: "unknown_skill", name } };
const resolved = [{ origin: "hermes" as const, requestedName: "selected-alias", name: descriptor.name, contentHash: hash }];
const observer = () => createTeamSkillProvisionObserver({ teamRunId: "team", members: [{ memberId: "worker", names: ["selected-alias"] }], catalog, resolved });
const dispatch = (text = `PRIVATE_ROLE_PROMPT\n${injectedText}\nTask:\ninspect`): ChildRequestDispatch => ({
  taskId: "task", agentId: "agent", round: 1, rootAttemptId: "root", parentToolCallId: "spawn-call",
  teamMember: { teamRunId: "team", memberId: "worker" },
  request: { attemptId: "request", model: "m", messages: [{ role: "user", content: text }], tools: [] },
});

test("acknowledged actual full injection yields only safe attributed provision metadata", async () => {
  const observe = observer();
  assert.ok(observe);
  const facts = await observe(dispatch());

  assert.deepEqual(facts, [{ kind: "skill_context_provided", version: 1, origin: "hermes", source: "team_selection",
    teamRunId: "team", memberId: "worker", taskId: "task", subagentId: "agent", rootAttemptId: "root", parentToolCallId: "spawn-call",
    requestId: "request", round: 1, skills: [{ name: "official-name", contentHash: hash }] }]);
  const encoded = JSON.stringify(facts);

  for (const privateText of ["PRIVATE_SKILL_BODY", "PRIVATE_ROLE_PROMPT", "D:/private", "selected-alias", "skill_view", "verified"]) {
    assert.equal(encoded.includes(privateText), false);
  }

  assert.deepEqual(await observe({ ...dispatch(), request: { ...dispatch().request, attemptId: "later-request" }, round: 2 }), []);
  assert.equal((await observe({ ...dispatch(), agentId: "another-agent" }))?.length, 1);
});

test("selection, partial body, another team/member and system-only text do not establish actual provision", async () => {
  const observe = observer();
  assert.ok(observe);
  assert.deepEqual(await observe(dispatch("Selected member skill: selected-alias\nPARTIAL")), []);
  assert.deepEqual(await observe({ ...dispatch(), teamMember: { teamRunId: "other", memberId: "worker" } }), []);
  assert.deepEqual(await observe({ ...dispatch(), teamMember: { teamRunId: "team", memberId: "person" } }), []);
  assert.deepEqual(await observe({ ...dispatch(), request: { ...dispatch().request, messages: [{ role: "system", content: injectedText }] } }), []);
  assert.equal((await observe(dispatch()))?.length, 1, "unmatched requests must not consume the first genuine observation");
});

test("a hash/body mismatch or unresolved local-only name never constructs a native provision observer", () => {
  const input = { teamRunId: "team", members: [{ memberId: "worker", names: ["selected-alias"] }], catalog };
  assert.equal(createTeamSkillProvisionObserver({ ...input, resolved: [] }), undefined);
  assert.equal(createTeamSkillProvisionObserver({ ...input, resolved: [{ ...resolved[0]!, contentHash: "0".repeat(64) }] }), undefined);
});
