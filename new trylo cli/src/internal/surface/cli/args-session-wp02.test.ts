import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";

/**
 * WP02 session/request argument contract (red-first).
 *
 * New verbs stay inside the `session` family (one family file, no second
 * dispatcher), and `run` gains exactly two resume-related flags: `--last`
 * (continue the newest active session) and `--migrate` (explicit,
 * closed-set config migration on resume). Anything else is a usage error.
 */

test("session list accepts search and all filters", () => {
  const parsed = parseArgs(["session", "list", "--search", "demo", "--all"]);
  assert.equal(parsed.kind, "session_list");
  if (parsed.kind !== "session_list") return;
  assert.equal(parsed.search, "demo");
  assert.equal(parsed.all, true);
});

test("session info names one session", () => {
  const parsed = parseArgs(["session", "info", "abc123", "--json"]);
  assert.equal(parsed.kind, "session_info");
  if (parsed.kind !== "session_info") return;
  assert.equal(parsed.options.session, "abc123");
  assert.equal(parsed.options.json, true);
});

test("session fork accepts a snapshot selector, never both", () => {
  const full = parseArgs(["session", "fork", "parent", "--new-id", "child", "--before-user-message", "2"]);
  assert.equal(full.kind, "session_fork");
  if (full.kind !== "session_fork") return;
  assert.equal(full.options.beforeUserMessage, 2);
  const both = parseArgs(["session", "fork", "parent", "--before-user-message", "2", "--interrupted"]);
  assert.equal(both.kind, "error");
});

test("session rename/export/archive/remove parse their targets", () => {
  const rename = parseArgs(["session", "rename", "abc123", "New name"]);

  assert.equal(rename.kind, "session_rename");
  const exported = parseArgs(["session", "export", "abc123", "--format", "markdown"]);

  assert.equal(exported.kind, "session_export");

  if (exported.kind !== "session_export") return;

  assert.equal(exported.options.format, "markdown");
  const badFormat = parseArgs(["session", "export", "abc123", "--format", "pdf"]);

  assert.equal(badFormat.kind, "error");
  assert.equal(parseArgs(["session", "archive", "abc123"]).kind, "session_archive");
  assert.equal(parseArgs(["session", "unarchive", "abc123"]).kind, "session_archive");
  assert.equal(parseArgs(["session", "remove", "abc123"]).kind, "session_remove");
});

test("run --last conflicts with explicit session selectors", () => {
  const last = parseArgs(["run", "--last", "hello"]);
  assert.equal(last.kind, "run");
  if (last.kind !== "run") return;
  assert.equal(last.options.resumeLast, true);
  assert.equal(parseArgs(["run", "--last", "--resume", "abc"]).kind, "error");
  assert.equal(parseArgs(["run", "--last", "--session", "abc"]).kind, "error");
});

test("run --migrate is a closed set and needs --resume", () => {
  const migrated = parseArgs(["run", "--resume", "abc", "--migrate", "model,catalog", "hello"]);

  assert.equal(migrated.kind, "run");

  if (migrated.kind !== "run") return;

  assert.equal(migrated.options.migrateModel, true);
  assert.equal(migrated.options.migrateCatalog, true);
  assert.equal(parseArgs(["run", "--resume", "abc", "--migrate", "workspace"]).kind, "error");
  assert.equal(parseArgs(["run", "--migrate", "model", "hello"]).kind, "error");
});
