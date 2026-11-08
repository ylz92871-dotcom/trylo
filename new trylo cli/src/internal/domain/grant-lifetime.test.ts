import assert from "node:assert/strict";
import test from "node:test";
import {
  CALL_QUESTION,
  GRANT_KINDS,
  LIFETIMES,
  TOOLING_QUESTION,
  grantSatisfies,
  isAuthorised,
  isGrantKind,
  sessionGrantCovers,
  substitutionRefusal,
} from "./grant-lifetime.js";
import {
  LEDGER_STATES,
  canTransition,
  describeEntry,
  entryAuthorises,
  recordEntry,
  type LedgerEntry,
} from "./permission-ledger.js";
import type { PermissionAction } from "../ports/permission.js";

/**
 * WP03.1 / WP03.3: the two contracts that had no enforcement before.
 *
 * Every "does not" case here is a case the old code could not even express: there
 * was no function that could refuse a cross-kind grant, and no ledger that could
 * refuse a backwards transition. They are written as refusals because that is
 * what they are.
 */

function actionOf(name: string, args: Record<string, unknown>): PermissionAction {
  const args2 = args as never;
  return {
    toolCallId: "call-1",
    name,
    arguments: args2,
    pattern: `${name}#${JSON.stringify(args)}`,
  };
}

test("the three kinds are named, and each has one lifetime", () => {
  assert.deepEqual([...GRANT_KINDS], ["tooling_once", "session", "policy"]);
  assert.deepEqual(LIFETIMES.tooling_once, {
    kind: "single_use",
    replay: "rejected",
    survives_restart: true,
  });
  assert.equal(LIFETIMES.session.survives_restart, false);
  assert.equal(LIFETIMES.session.replay, "not_applicable");
  assert.equal(LIFETIMES.policy.kind, "until_revoked");
  assert.equal(isGrantKind("session"), true);
  assert.equal(isGrantKind("ledger"), false);
  assert.equal(isGrantKind(undefined), false);
});

test("no grant of one kind answers another's question", () => {
  // The whole point of the file. A session answer must not silence a durable
  // ledger, and a written rule must not be spent as a one-time grant.
  assert.equal(grantSatisfies("session", TOOLING_QUESTION), false);
  assert.equal(grantSatisfies("tooling_once", "session"), false);
  assert.equal(grantSatisfies("policy", TOOLING_QUESTION), false);
  assert.equal(grantSatisfies("tooling_once", "policy"), false);
  assert.equal(grantSatisfies("session", "policy"), false);
  assert.equal(grantSatisfies("policy", "session"), false);
});

test("a grant answers only the questions its kind was issued for", () => {
  for (const kind of GRANT_KINDS) {
    assert.equal(grantSatisfies(kind, kind), true, `${kind} answers itself`);
  }

  // The asymmetry the file exists to state: an ordinary call is a session or
  // policy question, and a durable tooling grant is not an answer to it.
  assert.equal(grantSatisfies("session", CALL_QUESTION), true);
  assert.equal(grantSatisfies("policy", CALL_QUESTION), true);
  assert.equal(grantSatisfies("tooling_once", CALL_QUESTION), false);
  assert.equal(grantSatisfies("session", TOOLING_QUESTION), false);
  assert.equal(grantSatisfies("policy", TOOLING_QUESTION), false);
});

test("an unknown question is refused rather than guessed", () => {
  // `grantSatisfies` is the allow-list; a question nobody wrote down is not in
  // it, and must not fall through to some default.
  assert.equal(grantSatisfies("session", "something_new"), false);
  assert.equal(grantSatisfies("session", ""), false);
  assert.equal(grantSatisfies("session", "CALL"), false);
});

test("matching is necessary and not sufficient", () => {
  assert.equal(isAuthorised({ held: "session", question: "session", matches: true }), true);
  assert.equal(isAuthorised({ held: "session", question: "session", matches: false }), false);
  assert.equal(isAuthorised({ held: undefined, question: "session", matches: true }), false);
  assert.equal(isAuthorised({ held: "session", question: "tooling_once", matches: true }), false);
});

test("a revoked grant authorises nothing, whatever matched", () => {
  assert.equal(
    isAuthorised({ held: "session", question: "session", matches: true, revoked: true }),
    false,
  );
});

test("a session grant covers the exact call and a different value is a different call", () => {
  const granted = actionOf("write_file", { path: "a.md" });
  assert.equal(sessionGrantCovers(granted, actionOf("write_file", { path: "a.md" })), true);
  assert.equal(sessionGrantCovers(granted, actionOf("write_file", { path: "b.md" })), false);
  assert.equal(sessionGrantCovers(granted, actionOf("write_file", { path: "a.md", content: "x" })), false);
  assert.equal(sessionGrantCovers(granted, actionOf("edit_file", { path: "a.md" })), false);
});

test("a substitution attempt is a named defect, not a boolean to be handled", () => {
  const refusal = substitutionRefusal("session", "tooling_once");
  assert.equal(refusal.refusal, "wrong_grant_kind");
  assert.equal(refusal.held, "session");
  assert.equal(refusal.question, "tooling_once");
});

test("the ledger states are three, and unknown is one of them", () => {
  assert.deepEqual([...LEDGER_STATES], ["issued", "committed", "unknown"]);
  assert.equal(LEDGER_STATES.includes("failed" as never), false);
});

test("a ledger may only open at issued and may only end once", () => {
  assert.equal(canTransition("issued", "committed"), true);
  assert.equal(canTransition("issued", "unknown"), true);
  assert.equal(canTransition("committed", "unknown"), false, "a recorded effect is not retractable");
  assert.equal(canTransition("unknown", "committed"), false, "a crash is not a success");
  assert.equal(canTransition("unknown", "issued"), false);
  assert.equal(canTransition("committed", "issued"), false);
});

function entry(state: LedgerEntry["state"], toolCallId = "call-1"): LedgerEntry {
  return { toolCallId, pattern: "write_file#abc", grantKind: "session", state, source: "prompt" };
}

test("a ledger refuses to open mid-story", () => {
  const empty = new Map<string, LedgerEntry>();
  for (const state of ["committed", "unknown"] as const) {
    const result = recordEntry(empty, entry(state));
    assert.equal(result.accepted, false, `a ledger may not open at ${state}`);
  }
  assert.equal(recordEntry(empty, entry("issued")).accepted, true);
});

test("the honest sequence is accepted and nothing is left behind", () => {
  const first = recordEntry(new Map(), entry("issued"));
  assert.equal(first.accepted, true);
  const second = recordEntry(first.ledger, entry("committed"));
  assert.equal(second.accepted, true);
  assert.equal(second.ledger.get("call-1")?.state, "committed");
});

test("a crash leaves unknown, and unknown never becomes committed", () => {
  const first = recordEntry(new Map(), entry("issued"));
  const crashed = recordEntry(first.ledger, entry("unknown"));
  assert.equal(crashed.accepted, true);
  const after = recordEntry(crashed.ledger, entry("committed"));
  assert.equal(after.accepted, false);
  assert.equal(after.ledger.get("call-1")?.state, "unknown", "the refused write does not land");
});

test("a redelivered record is not a tampered one", () => {
  const first = recordEntry(new Map(), entry("issued"));
  const again = recordEntry(first.ledger, entry("issued"));
  assert.equal(again.accepted, true, "the same claim arriving twice is still one claim");
  assert.equal(again.ledger.size, 1);
});

test("an entry only authorises through the kind check, not by being present", () => {
  assert.equal(entryAuthorises(entry("issued")), true, "a session entry answers an ordinary call");
  // Well-formed, present, and still unable to speak for a durable install.
  const toolingEntry: LedgerEntry = { ...entry("issued"), grantKind: "tooling_once" };

  assert.equal(entryAuthorises(toolingEntry), false);
  const policyEntry: LedgerEntry = { ...entry("issued"), grantKind: "policy" };

  assert.equal(entryAuthorises(policyEntry), true);
  // A crash does not retract the question that was already asked of the ledger.
  assert.equal(entryAuthorises(entry("unknown")), true);
});

test("a reader is shown the unknowns", () => {
  const described = describeEntry(entry("unknown"));

  assert.equal(described.state, "unknown");
  assert.equal(described.grantKind, "session");
  assert.equal(described.source, "prompt");
  // Surfaced, not filtered: the state is visible in the same record that says
  // what was authorised, so a reader cannot mistake it for a clean success.
  assert.equal(described.authorises, true);
  const toolingDescribed = describeEntry({ ...entry("unknown"), grantKind: "tooling_once" });

  assert.equal(toolingDescribed.authorises, false);
});
