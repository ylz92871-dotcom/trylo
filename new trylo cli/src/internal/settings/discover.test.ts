import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_CONFIG_RELATIVE,
  SYSTEM_CONFIG_RELATIVE,
  USER_CONFIG_RELATIVE,
  discoverSettingsPaths,
  isPathWithinRoot,
  selectCandidate,
} from "./discover.js";

/**
 * Discovery is pure path logic. These tests pin: which layers get a plan, the
 * exact candidate paths, the workspace-containment guard (adversarial #6, tested
 * at the lowest meaningful layer because a frozen `join(root, ".trylo/config.json")`
 * can never escape on its own), and the first-existing-wins candidate probe
 * (adversarial #9).
 */

test("no systemDir means no system plan (missing, not an error)", () => {
  const result = discoverSettingsPaths({ homeDir: "/home/u", workspaceDir: "/ws" });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.deepEqual(
      result.plans.map((p) => p.layer),
      ["user", "project"],
    );
  }
});

test("systemDir present adds the system plan first (lowest file precedence)", () => {
  const result = discoverSettingsPaths({
    systemDir: "/etc/trylo",
    homeDir: "/home/u",
    workspaceDir: "/ws",
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.deepEqual(
      result.plans.map((p) => p.layer),
      ["system", "user", "project"],
    );
    assert.deepEqual(result.plans[0]?.candidates, [path.join("/etc/trylo", SYSTEM_CONFIG_RELATIVE)]);
  }
});

test("user and project candidate paths are exactly <root>/.trylo/config.json", () => {
  const result = discoverSettingsPaths({ homeDir: "/home/u", workspaceDir: "/ws" });

  assert.equal(result.ok, true);

  if (result.ok) {
    const user = result.plans.find((p) => p.layer === "user");
    const project = result.plans.find((p) => p.layer === "project");
    assert.deepEqual(user?.candidates, [path.join("/home/u", USER_CONFIG_RELATIVE)]);
    assert.deepEqual(project?.candidates, [path.join("/ws", PROJECT_CONFIG_RELATIVE)]);
  }
});

test("isPathWithinRoot accepts a strictly-inside path", () => {
  assert.equal(isPathWithinRoot("ws", path.join("ws", ".trylo", "config.json")), true);
  assert.equal(isPathWithinRoot("/a/b", "/a/b/c/d.json"), true);
});

test("isPathWithinRoot refuses an escaping or equal path (adversarial #6)", () => {
  assert.equal(isPathWithinRoot("/ws", "/etc/passwd"), false);
  assert.equal(isPathWithinRoot("/ws", "/ws/../escape/config.json"), false);
  assert.equal(isPathWithinRoot("ws", "other/config.json"), false);
  // candidate === root is not "inside" root
  assert.equal(isPathWithinRoot("/ws", "/ws"), false);
});

test("a normal workspace passes the discover-level containment guard", () => {
  const result = discoverSettingsPaths({ homeDir: "/home/u", workspaceDir: "/ws" });
  assert.equal(result.ok, true);
});

test("selectCandidate takes the first existing file and ignores the rest (adversarial #9)", () => {
  const files: Record<string, string> = {
    "/dir/first.json": "FIRST",
    "/dir/second.json": "SECOND",
  };
  const readFile = (p: string): string | undefined => files[p];
  const selected = selectCandidate(["/dir/first.json", "/dir/second.json"], readFile);

  assert.equal(selected?.path, "/dir/first.json");
  assert.equal(selected?.raw, "FIRST");
});

test("selectCandidate skips a missing first candidate and takes the next existing", () => {
  const files: Record<string, string> = { "/dir/second.json": "SECOND" };
  const readFile = (p: string): string | undefined => files[p];
  const selected = selectCandidate(["/dir/first.json", "/dir/second.json"], readFile);
  assert.equal(selected?.path, "/dir/second.json");
});

test("selectCandidate returns undefined when no candidate exists (missing layer)", () => {
  const readFile = (): string | undefined => undefined;
  assert.equal(selectCandidate(["/dir/a.json", "/dir/b.json"], readFile), undefined);
});
