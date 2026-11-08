import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRulesFor } from "./project-rules.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SessionRecord } from "../../ports/session.js";
import { ruleChangeNotice, ruleChangeNoticeFor, ruleChangesBetween } from "./rule-changes.js";
import type { ProjectInstructionSource } from "./host.js";

/**
 * WP-CLI-B1 §9: a resumed run must be able to say which project rules changed.
 *
 * The failure this guards against is specific and quiet. A user edits
 * `AGENTS.md` on Monday, resumes on Tuesday, and the model stops following a
 * convention it followed last week. Nothing errors. Nothing is logged unless this
 * code says so, and the user's only explanation would be that the tool lost the
 * rules — when in fact the tool read the new ones, correctly.
 *
 * So the change has to be *visible*, and visible without rewriting history: the
 * journal keeps what was true then, and the run reports what is true now.
 */

function source(
  relativePath: string,
  contentHash: string,
  scope: ProjectInstructionSource["scope"] = "workspace_root",
  scopePath = ".",
): ProjectInstructionSource {
  return { relativePath, scopePath, contentHash, scope };
}

/** A journal whose last turn recorded these rule sources. */
function journalWith(sources: ReadonlyArray<ProjectInstructionSource>): SessionRecord[] {
  const payload: JsonObject =
    sources.length === 0
      ? {}
      : { projectInstructions: sources.map((entry) => ({ ...entry })) };
  return [
    {
      formatVersion: "1",
      sequence: 1,
      type: "turn_start",
      sessionId: "ses-x",
      turnId: "trn-1",
      at: "2026-10-01T00:00:00.000Z",
      payload: {},
    },
    {
      formatVersion: "1",
      sequence: 2,
      type: "turn_start",
      sessionId: "ses-x",
      turnId: "trn-2",
      at: "2026-10-01T00:01:00.000Z",
      payload,
    },
  ];
}

test("an edited rule file is reported as changed", () => {
  const records = journalWith([source("AGENTS.md", "aaaaaaaaaaaaaaa1")]);
  const changes = ruleChangesBetween(records, [source("AGENTS.md", "bbbbbbbbbbbbbbb2")]);
  assert.deepEqual(changes, [{ kind: "changed", relativePath: "AGENTS.md" }]);
});

test("a rule file that appeared is reported as new", () => {
  const records = journalWith([source("AGENTS.md", "aaaaaaaaaaaaaaa1")]);
  const changes = ruleChangesBetween(records, [
    source("AGENTS.md", "aaaaaaaaaaaaaaa1"),
    source("src/AGENTS.md", "ccccccccccccccc3", "directory", "src"),
  ]);
  assert.deepEqual(changes, [{ kind: "added", relativePath: "src/AGENTS.md" }]);
});

test("a rule file that was deleted is reported as gone", () => {
  const records = journalWith([
    source("AGENTS.md", "aaaaaaaaaaaaaaa1"),
    source("src/AGENTS.md", "ccccccccccccccc3", "directory", "src"),
  ]);
  const changes = ruleChangesBetween(records, [source("AGENTS.md", "aaaaaaaaaaaaaaa1")]);
  assert.deepEqual(changes, [{ kind: "removed", relativePath: "src/AGENTS.md" }]);
});

/**
 * The case that must be silent.
 *
 * Most resumes adopt exactly the rules the journal recorded, and a note printed
 * every time would train the user to scroll past the one resume where the note
 * was the whole point.
 */
test("an unchanged rule set produces no notice at all", () => {
  const records = journalWith([
    source("AGENTS.md", "aaaaaaaaaaaaaaa1"),
    source("src/AGENTS.md", "ccccccccccccccc3", "directory", "src"),
  ]);
  const same = [
    source("AGENTS.md", "aaaaaaaaaaaaaaa1"),
    source("src/AGENTS.md", "ccccccccccccccc3", "directory", "src"),
  ];

  assert.deepEqual(ruleChangesBetween(records, same), []);
  // `undefined`, not an empty string: the caller writes stderr only when there
  // is something to write, and an empty string would still be a blank line.
  assert.equal(ruleChangeNotice(ruleChangesBetween(records, same)), undefined);
});

test("the last turn that recorded rules is the one compared", () => {
  // A session records the list on every `turn_start`. Only the newest statement
  // describes the rules the previous run actually used; comparing against the
  // oldest would report a change on every resume of a project whose rules were
  // edited once, forever.
  const records = journalWith([source("AGENTS.md", "oldoldoldoldold1")]);

  records.push({
    formatVersion: "1",
    sequence: 3,
    type: "turn_start",
    sessionId: "ses-x",
    turnId: "trn-3",
    at: "2026-10-01T00:02:00.000Z",
    payload: { projectInstructions: [{ ...source("AGENTS.md", "newnewnewnewnew2") }] },
  });
  assert.deepEqual(ruleChangesBetween(records, [source("AGENTS.md", "newnewnewnewnew2")]), []);
});

test("a journal written before rules existed claims nothing was added", () => {
  // No `projectInstructions` at all means "this build did not record them", which
  // is not the same as "the project gained a rule file since last time".
  const old: SessionRecord[] = [
    {
      formatVersion: "1",
      sequence: 1,
      type: "turn_start",
      sessionId: "ses-x",
      at: "2026-09-01T00:00:00.000Z",
      payload: { iterations: 3 },
    },
  ];
  assert.deepEqual(ruleChangesBetween(old, [source("AGENTS.md", "aaaaaaaaaaaaaaa1")]), []);
});

test("a malformed journal entry is skipped, not believed", () => {
  // The payload is whatever the writer put there, and a journal is a file on
  // disk. Half a record must not become half a claim.
  const records: SessionRecord[] = [
    {
      formatVersion: "1",
      sequence: 1,
      type: "turn_start",
      sessionId: "ses-x",
      at: "2026-10-01T00:00:00.000Z",
      payload: {
        projectInstructions: [
          { ...source("AGENTS.md", "aaaaaaaaaaaaaaa1") },
          { relativePath: "src/AGENTS.md", scope: "directory" },
          "not even an object",
        ],
      },
    },
  ];
  assert.deepEqual(ruleChangesBetween(records, [source("AGENTS.md", "aaaaaaaaaaaaaaa1")]), []);
});

test("no records and no current rules are both silent", () => {
  assert.deepEqual(ruleChangesBetween(undefined, [source("AGENTS.md", "a1")]), []);
  assert.deepEqual(ruleChangesBetween(journalWith([]), undefined), []);
  assert.equal(ruleChangeNoticeFor(undefined, undefined), undefined);
});

test("the notice names the files, says which run used what, and claims nothing more", () => {
  const notice = ruleChangeNotice([
    { kind: "changed", relativePath: "AGENTS.md" },
    { kind: "added", relativePath: "src/AGENTS.md" },
    { kind: "removed", relativePath: "docs/AGENTS.md" },
  ]);

  assert.ok(notice);
  assert.match(notice, /AGENTS\.md \(edited\)/);
  assert.match(notice, /src\/AGENTS\.md \(new\)/);
  assert.match(notice, /docs\/AGENTS\.md \(gone\)/);
  // The sentence has to tell the user which of the two facts applies to this run,
  // or the note itself becomes the new mystery.
  assert.match(notice, /This run uses the current files/);
  assert.match(notice, /earlier turns used the versions in the journal/);
  // And it must not imply the journal was rewritten.
  assert.doesNotMatch(notice, /updated|rewritten|now recorded/i);
});

test("a removed local rule is reported only when its subtree is read, once per turn", t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-local-drift-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "other"));
  const recorded = source("src/AGENTS.md", "aaaa", "directory", "src");
  const record: SessionRecord = {
    formatVersion: "1", sequence: 1, type: "envelope", sessionId: "s", turnId: "t", at: "2026-10-03T00:00:00Z",
    payload: { envelope: { payload: { value: { localRules: [{ ...recorded }] } } } },
  };
  const warnings: string[] = [];
  const lookup = localRulesFor(root, undefined, message => warnings.push(message), [record]);

  lookup?.(join(root, "other", "file.ts"));
  assert.equal(warnings.length, 0);
  lookup?.(join(root, "src", "file.ts"));
  lookup?.(join(root, "src", "second.ts"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /src\/AGENTS\.md \(gone\)/);
});
