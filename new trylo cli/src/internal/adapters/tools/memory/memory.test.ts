import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryDocument, MemoryReadPort } from "../../../ports/memory.js";
import { createMemoryReadPort } from "./port.js";
import { createMatcher, hitsInDocument, windowFor } from "./matcher.js";

/**
 * Memory retrieval, over documents held in memory.
 *
 * Three things are being proven here, and the third is the one that matters most:
 *
 *  - the match modes do what they say — `any`, `all_on_same_line`, and
 *    `all_within_lines` are three different questions and must give three
 *    different answers;
 *  - normalisation is comparison, not guessing: `read-file` matches `read file`,
 *    and a line that contains neither is never a hit;
 *  - **a new record becomes visible without a refresh.** The document source is
 *    re-read per call precisely so a rule activated after the port was built can
 *    be found. A source captured once would answer "no matches" forever, and the
 *    model would have no way to tell that from having forgotten everything.
 */

const DOC: MemoryDocument = {
  id: "asset-1",
  path: "trylo://learning/board",
  origin: "learning:user_rule:repo",
  lines: [
    "Always run the quality gate before committing.",
    "Prefer edit_file over write_file for existing sources.",
    "read_file returns ranges; read file with a limit.",
    "Do not raise the frozen thresholds to make a gate pass.",
    "The gate is eleven steps.",
  ],
};

function portOver(documents: ReadonlyArray<MemoryDocument>): MemoryReadPort {
  return createMemoryReadPort(async () => ({ documents }));
}

function searchArgs(over: Partial<Parameters<MemoryReadPort["search"]>[0]> = {}) {
  return {
    queries: ["read"],
    matchMode: "any" as const,
    contextLines: 0,
    caseSensitive: true,
    normalized: false,
    maxResults: 20,
    ...over,
  };
}

const signal = new AbortController().signal;

test("user-memory lists advance their cursor and category filtering precedes pagination", async () => {
  const documents: MemoryDocument[] = Array.from({ length: 12 }, (_, index) => ({
    id: `user-memory:${index}`, path: "trylo://user", origin: "user-memory", recordKind: index === 11 ? "identity_fact" : "preference",
    lines: [index === 11 ? "我是 Last-Person" : `偏好 ${index}`, `metadata ${index}`],
  }));
  const port = portOver(documents);
  const first = await port.search(searchArgs({ queries: [] }), signal);
  const next = await port.search(searchArgs({ queries: [], cursor: "20" }), signal);

  assert.equal(first.ok && first.matches.length, 20);
  assert.equal(next.ok && next.matches[0]?.documentId, "user-memory:10");
  assert.equal(next.ok && next.truncated, false);

  for (const cursor of ["20junk", "-1", "25", "1.2"]) {
    const result = await port.search(searchArgs({ queries: [], cursor }), signal);
    assert.equal(result.ok, false, cursor);
  }

  const identity = await port.search(searchArgs({ queries: [], recordKind: "identity_fact" }), signal);

  assert.equal(identity.ok && identity.matches[0]?.content, "我是 Last-Person");
  assert.equal(identity.ok && identity.matches.length, 2);
});

test("`any` matches each query independently and reports which query hit", async () => {
  // `read` is on line 3 only; `gate` is on lines 1, 4 and 5. Four hits, and the
  // one on line 3 says which of the two queries produced it.
  const outcome = await portOver([DOC]).search(searchArgs({ queries: ["read", "gate"] }), signal);

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.equal(outcome.matches.length, 4);
  const hit = outcome.matches.find((match) => match.matchLineNumber === 3);

  assert.deepEqual(hit?.matchedQueries, ["read"]);
  const gateHit = outcome.matches.find((match) => match.matchLineNumber === 1);

  assert.deepEqual(gateHit?.matchedQueries, ["gate"]);
});

test("`all_on_same_line` requires the queries to be together, not merely present", async () => {
  const outcome = await portOver([DOC]).search(
    searchArgs({ queries: ["read", "gate"], matchMode: "all_on_same_line" }),
    signal,
  );

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.matches.length, 0, "no line holds both queries");
  }
});

test("`all_within_lines` finds each minimal window, not every window containing one", () => {
  const matcher = createMatcher({
    queries: ["read", "gate"],
    window: { kind: "all_within_lines", lineCount: 5 },
    caseSensitive: true,
    normalized: false,
  });
  const hits = hitsInDocument(DOC.lines, matcher, { kind: "all_within_lines", lineCount: 5 });

  // Two distinct windows over 1-indexed lines 1–3 and 3–4. The second shrinks to
  // end at the last line that actually matched, so `The gate is eleven steps`
  // does not ride along in every hit. Reporting every overlapping range instead
  // would put one fact on the page twice.
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { matchStartIndex: 0, matchEndIndex: 2, matchedQueries: ["read", "gate"] });
  assert.deepEqual(hits[1], { matchStartIndex: 2, matchEndIndex: 3, matchedQueries: ["read", "gate"] });
});

test("normalisation makes separators irrelevant but never invents a hit", () => {
  const matcher = createMatcher({
    queries: ["read-file"],
    window: { kind: "any" },
    caseSensitive: true,
    normalized: true,
  });

  assert.equal(hitsInDocument(DOC.lines, matcher, { kind: "any" }).length, 1);
  const absent = createMatcher({
    queries: ["nonexistent-token"],
    window: { kind: "any" },
    caseSensitive: true,
    normalized: true,
  });

  assert.equal(hitsInDocument(DOC.lines, absent, { kind: "any" }).length, 0);
});

test("case folding is opt-in, and the default is exact", () => {
  const sensitive = createMatcher({
    queries: ["READ"],
    window: { kind: "any" },
    caseSensitive: true,
    normalized: false,
  });

  assert.equal(hitsInDocument(DOC.lines, sensitive, { kind: "any" }).length, 0);
  const insensitive = createMatcher({
    queries: ["READ"],
    window: { kind: "any" },
    caseSensitive: false,
    normalized: false,
  });

  assert.equal(hitsInDocument(DOC.lines, insensitive, { kind: "any" }).length, 1);
});

test("context lines widen a hit without moving where it matched", async () => {
  const outcome = await portOver([DOC]).search(
    searchArgs({ queries: ["thresholds"], contextLines: 1 }),
    signal,
  );

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    const only = outcome.matches[0];
    assert.equal(only?.matchLineNumber, 4, "the hit stays on the line that matched");
    assert.equal(only?.contentStartLineNumber, 3, "one line of leading context");
    assert.match(only?.content ?? "", /^read_file returns ranges/);
  }
});

test("a record written after the port was built is visible to the next search", async () => {
  // The whole reason the source is re-read per call.
  let documents: ReadonlyArray<MemoryDocument> = [];
  const port = createMemoryReadPort(async () => ({ documents }));
  const before = await port.search(searchArgs({ queries: ["telemetry"] }), signal);

  assert.equal(before.ok, true);

  if (before.ok) {
    assert.equal(before.matches.length, 0);
  }

  documents = [{ ...DOC, id: "asset-2", lines: ["Ship telemetry for every new tool."] }];
  const after = await port.search(searchArgs({ queries: ["telemetry"] }), signal);

  assert.equal(after.ok, true);

  if (after.ok) {
    assert.equal(after.matches.length, 1);
    assert.equal(after.matches[0]?.documentId, "asset-2");
  }
});

test("pagination issues a cursor only when more matches remain, and a stale cursor is refused", async () => {
  const many: MemoryDocument = {
    ...DOC,
    lines: Array.from({ length: 25 }, (_unused, index) => `read line ${index + 1}`),
  };
  const port = portOver([many]);
  const first = await port.search(searchArgs({ queries: ["read"], maxResults: 10 }), signal);

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  assert.equal(first.matches.length, 10);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, "10");

  const second = await port.search(
    searchArgs({ queries: ["read"], maxResults: 10, cursor: first.nextCursor }),
    signal,
  );

  assert.equal(second.ok, true);

  if (second.ok) {
    assert.equal(second.matches[0]?.matchLineNumber, 11);
    assert.equal(second.truncated, true);
  }

  const beyond = await port.search(searchArgs({ queries: ["read"], cursor: "9999" }), signal);

  assert.equal(beyond.ok, false);

  if (!beyond.ok) {
    assert.equal(beyond.code, "invalid_cursor", "a stale cursor is a refusal, not an empty page");
  }
});

test("an unknown document is refused distinctly from an empty corpus", async () => {
  const port = portOver([DOC]);
  const missing = await port.search(searchArgs({ documentId: "nope" }), signal);

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.code, "unknown_document");
  }

  const empty = await port.search(searchArgs({ queries: ["nothing-matches-this"] }), signal);

  assert.equal(empty.ok, true);

  if (empty.ok) {
    assert.equal(empty.matches.length, 0, "an empty result is a result, not a failure");
  }
});

test("an empty query is refused rather than matching everything", async () => {
  const outcome = await portOver([DOC]).search(searchArgs({ queries: ["  "] }), signal);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "empty_query");
  }
});

test("read returns a 1-indexed window and says whether more remains", async () => {
  const port = portOver([DOC]);
  const outcome = await port.read({ documentId: DOC.id, lineOffset: 2, maxLines: 2 }, signal);

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.startLineNumber, 2);
    assert.equal(outcome.totalLines, 5);
    assert.equal(outcome.truncated, true);
    assert.match(outcome.content, /^Prefer edit_file/);
  }

  const past = await port.read({ documentId: DOC.id, lineOffset: 99 }, signal);

  assert.equal(past.ok, false);

  if (!past.ok) {
    assert.equal(past.code, "invalid_line_offset");
  }
});

test("windowFor clamps a silly line_count instead of refusing the call", () => {
  assert.deepEqual(windowFor("all_within_lines"), { kind: "all_within_lines", lineCount: 5 });
  assert.deepEqual(windowFor("all_within_lines", 0), { kind: "all_within_lines", lineCount: 1 });
  assert.deepEqual(windowFor("any"), { kind: "any" });
});
