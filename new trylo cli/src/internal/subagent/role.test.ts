import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROLE_NAME,
  uniqueNicknameFor,
  resolveRole,
  roleCatalogDescription,
  type SubagentRole,
} from "./role.js";

/**
 * The one property this file exists for (WP22.2b / C44).
 *
 * Codex states it in a comment at `core/src/agent/role.rs:2`: a role may
 * customise the child or reduce its capabilities, but must never replace the
 * parent session's authority. Every test here is one way a role file could
 * quietly break that — a wish list naming a tool the parent cannot use, a turn
 * ceiling above the parent's, a model the parent never agreed to.
 */

const PARENT = {
  model: "parent-model",
  allowedTools: ["read_file", "search_text", "write_file"],
  maxIterations: 10,
};

function role(overrides: Partial<SubagentRole>): SubagentRole {
  return { name: "tester", description: "a role", ...overrides };
}

test("a role naming a tool the parent lacks gets the intersection, and says so", () => {
  const resolved = resolveRole(
    [role({ allowedTools: ["read_file", "run_shell"] })],
    "tester",
    PARENT,
  );

  assert.deepEqual(resolved.allowedTools, ["read_file"]);
  // Refusing to spawn over a config file's optimism would turn a typo into an
  // outage; narrowing is safe, so it narrows and reports.
  assert.deepEqual(resolved.withheld, ["run_shell"]);
});

test("a role with no wish list inherits the parent's tools minus its own denials", () => {
  const resolved = resolveRole([role({ disallowedTools: ["write_file"] })], "tester", PARENT);
  assert.deepEqual(resolved.allowedTools, ["read_file", "search_text"]);
  assert.deepEqual(resolved.withheld, []);
});

test("a role's denials beat its own wish list", () => {
  const resolved = resolveRole(
    [role({ allowedTools: ["read_file", "write_file"], disallowedTools: ["write_file"] })],
    "tester",
    PARENT,
  );
  assert.deepEqual(resolved.allowedTools, ["read_file"]);
});

test("a role may ask for a lower turn ceiling but not a higher one", () => {
  const lower = resolveRole([role({ maxIterations: 3 })], "tester", PARENT);

  assert.equal(lower.maxIterations, 3);
  const higher = resolveRole([role({ maxIterations: 99 })], "tester", PARENT);

  assert.equal(
    higher.maxIterations,
    10,
    "a role must not buy more turns than the parent has",
  );
});

test("a role's model overrides the parent's, and 'inherit' means no override", () => {
  assert.equal(resolveRole([role({ model: "special" })], "tester", PARENT).model, "special");
  assert.equal(resolveRole([role({ model: "inherit" })], "tester", PARENT).model, "parent-model");
  assert.equal(resolveRole([role({})], "tester", PARENT).model, "parent-model");
});

test("an unknown role name runs with the parent's own settings", () => {
  const resolved = resolveRole([role({})], "no-such-role", PARENT);
  assert.equal(resolved.role.name, "no-such-role");
  assert.deepEqual(resolved.allowedTools, PARENT.allowedTools);
  assert.equal(resolved.model, PARENT.model);
});

test("an omitted role name means the default one", () => {
  const catalog = [role({ name: DEFAULT_ROLE_NAME, allowedTools: ["read_file"] })];
  const resolved = resolveRole(catalog, undefined, PARENT);
  assert.deepEqual(resolved.allowedTools, ["read_file"]);
});

test("an omitted role with no default.md says so instead of blaming the request", () => {
  const resolved = resolveRole([], undefined, PARENT);
  assert.equal(resolved.role.name, DEFAULT_ROLE_NAME);
  assert.deepEqual(resolved.allowedTools, PARENT.allowedTools);
  assert.match(resolved.role.description, /No default role configured/);
});

test("with no roles the catalog description is empty, so the tool text is unchanged", () => {
  assert.equal(roleCatalogDescription([]), "");
  assert.match(
    roleCatalogDescription([role({ name: "reviewer", description: "reads and reports" })]),
    /reviewer: reads and reports/,
  );
});

test("nicknames never repeat while an agent with that name is still around", () => {
  const scout = role({ nicknameCandidates: ["scout"] });

  assert.equal(uniqueNicknameFor(scout, "agent-1", new Set()), "scout");
  // The second instance of the same role must not answer to the same name:
  // the model reads these, and "ask scout" has to name one agent.
  assert.equal(uniqueNicknameFor(scout, "agent-2", new Set(["scout"])), "scout-2");
  const many = new Set(["scout", "scout-2", "scout-3"]);

  assert.equal(uniqueNicknameFor(scout, "agent-9", many), "scout-4");
});

test("a role with several candidates uses the first free one", () => {
  const two = role({ nicknameCandidates: ["first", "second"] });
  assert.equal(uniqueNicknameFor(two, "a", new Set(["first"])), "second");
});

test("a role with no candidates falls back to the agent id", () => {
  assert.equal(uniqueNicknameFor(role({}), "agent-7", new Set()), "agent-7");
});
