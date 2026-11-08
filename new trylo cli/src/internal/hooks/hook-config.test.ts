import assert from "node:assert/strict";
import test from "node:test";
import {
  HOOK_SOURCE_ORDER,
  matchesMatcher,
  selectHooks,
  type HookConfig,
  type HookStore,
} from "./hook-config.js";
import { HOOK_EVENTS, isMatcherEvent } from "./hook-events.js";

/**
 * WP17.1 配置与事件映射：matcher 语义与事件选择。
 *
 * 语义复用旧 CLI `utils/hooks.ts#matchesPattern` 的机械层（空/缺省直通、
 * `*` 直通、`a|b` 精确分支、其余按正则、非法正则 fail-closed 不命中），
 * 事件集合取旧 CLI 27 种与 Codex 12 种的交集并保留 file-change/CWD/
 * worktree/指令载入（L63 要求）。
 */

function commandHook(id: string, event: (typeof HOOK_EVENTS)[number], matcher?: string): HookConfig {
  return {
    id,
    event,
    source: "project",
    ...(matcher === undefined ? {} : { matcher }),
    kind: "command",
    command: ["hook-runner", id],
    timeoutMs: 1000,
  };
}

test("an absent, empty, or star matcher matches every value", () => {
  assert.equal(matchesMatcher(undefined, "Write"), true);
  assert.equal(matchesMatcher("", "Write"), true);
  assert.equal(matchesMatcher("*", "Write"), true);
  assert.equal(matchesMatcher(undefined, ""), true);
});

test("a bare word matches exactly, never as a substring", () => {
  assert.equal(matchesMatcher("Write", "Write"), true);
  assert.equal(matchesMatcher("Write", "Edit"), false);
  // No regex fallthrough on the fast branch: /Write/ would match, but the
  // old CLI returns on exact equality first.
  assert.equal(matchesMatcher("Write", "WriteFile"), false);
  assert.equal(matchesMatcher("Bash", "BashTool"), false);
});

test("pipe-separated alternatives match whole values only", () => {
  assert.equal(matchesMatcher("Write|Edit", "Edit"), true);
  assert.equal(matchesMatcher("Write|Edit", "Edi"), false);
  assert.equal(matchesMatcher("Write|Edit", "WriteFile"), false);
  assert.equal(matchesMatcher("Write|Edit", "MultiEdit"), false);
});

test("anything outside [a-zA-Z0-9_|] is a regular expression over the value", () => {
  assert.equal(matchesMatcher("Wri.*", "Write"), true);
  assert.equal(matchesMatcher("^Edit$", "Edit"), true);
  assert.equal(matchesMatcher("^Edit$", "MyEdit"), false);
  assert.equal(matchesMatcher("^(Write|Edit)$", "WriteFile"), false);
  assert.equal(matchesMatcher("^(Write|Edit)$", "Edit"), true);
});

test("invalid regular expressions never match (fail-closed)", () => {
  assert.equal(matchesMatcher("([", "Write"), false);
  assert.equal(matchesMatcher("([", ""), false);
  // No exact-equality escape hatch outside the fast branch: the old CLI runs
  // "([ " through `new RegExp`, which throws, so even value "([" is false.
  assert.equal(matchesMatcher("([", "(["), false);
});

/**
 * Side-by-side truth table against the old CLI `matchesPattern`
 * (`D:/CC/trylo/trylo cli/src/utils/hooks.ts`, read 2026-10-06).
 *
 * This table is the permanent guard for P0-1 (2026-10-06 review): an earlier
 * revision of `matchesMatcher` fell every fast-branch miss through to the
 * regex and over-triggered, and the tests then asserted that deviation as
 * "Legacy parity". Any change to matcher semantics must re-verify each row
 * against the old function, not against this file's implementation.
 */
test("truth table against the old CLI matchesPattern", () => {
  const rows: ReadonlyArray<{ readonly matcher: string; readonly value: string; readonly expected: boolean }> = [
    { matcher: "Bash", value: "Bash", expected: true },
    { matcher: "Bash", value: "BashTool", expected: false },
    { matcher: "Write", value: "Write", expected: true },
    { matcher: "Write", value: "WriteFile", expected: false },
    { matcher: "Write|Edit", value: "Write", expected: true },
    { matcher: "Write|Edit", value: "Edit", expected: true },
    { matcher: "Write|Edit", value: "WriteFile", expected: false },
    { matcher: "Write|Edit", value: "MultiEdit", expected: false },
    { matcher: "Write|Edit", value: "Edi", expected: false },
  ];
  for (const row of rows) {
    assert.equal(
      matchesMatcher(row.matcher, row.value),
      row.expected,
      `matcher ${JSON.stringify(row.matcher)} against ${JSON.stringify(row.value)}`,
    );
  }
});

test("matcher-applicable events filter by the caller-supplied value", () => {
  assert.equal(isMatcherEvent("PreToolUse"), true);
  assert.equal(isMatcherEvent("SessionStart"), false);
  const store: HookStore = {
    hooks: [commandHook("write-only", "PreToolUse", "Write"), commandHook("any-tool", "PreToolUse")],
  };

  assert.deepEqual(
    selectHooks(store, "PreToolUse", "Write").map((hook) => hook.id),
    ["any-tool", "write-only"],
  );
  assert.deepEqual(
    selectHooks(store, "PreToolUse", "Edit").map((hook) => hook.id),
    ["any-tool"],
  );
});

test("always-run events ignore the matcher and still fire once each", () => {
  const store: HookStore = {
    hooks: [commandHook("scoped", "SessionStart", "Write"), commandHook("open", "SessionStart")],
  };
  assert.deepEqual(
    selectHooks(store, "SessionStart", "Edit").map((hook) => hook.id),
    ["open", "scoped"],
  );
});

test("selection order is source priority, then matcher, then id", () => {
  assert.deepEqual([...HOOK_SOURCE_ORDER], ["user", "project", "managed", "session"]);
  const store: HookStore = {
    hooks: [
      { ...commandHook("b-id", "PreToolUse"), source: "user" },
      { ...commandHook("a-id", "PreToolUse"), source: "user" },
      { ...commandHook("z-matcher", "PreToolUse", "Write"), source: "user" },
      { ...commandHook("project-hook", "PreToolUse"), source: "project" },
      { ...commandHook("other-event", "PostToolUse"), source: "user" },
    ],
  };

  assert.deepEqual(
    selectHooks(store, "PreToolUse", "Write").map((hook) => hook.id),
    ["a-id", "b-id", "z-matcher", "project-hook"],
  );
});

test("disableAll and per-id disables remove hooks without touching the store", () => {
  const store: HookStore = {
    hooks: [commandHook("a", "PreToolUse"), commandHook("b", "PreToolUse")],
    disabledIds: new Set(["a"]),
  };

  assert.deepEqual(
    selectHooks(store, "PreToolUse", "Write").map((hook) => hook.id),
    ["b"],
  );
  assert.deepEqual(selectHooks({ ...store, disableAll: true }, "PreToolUse", "Write"), []);
  // The store itself is untouched: disabling is a read-time filter.
  assert.equal(store.hooks.length, 2);
});
