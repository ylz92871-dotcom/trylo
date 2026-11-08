import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_DECISIONS,
  EMPTY_POLICY,
  parseExecPolicyDocument,
  evaluateExecPolicy,
  allowedPrefixes,
  mergeExecPolicy,
  strictestOf,
  executableBasename,
  matchesForCommand,
  withPrefixRule,
  type ExecPolicy,
  type PrefixRule,
  type SourcePlatform,
} from "./index.js";

/**
 * The evaluator's invariants (C66/L64).
 *
 * Every case here is either copied from Codex's own tests in
 * `execpolicy/src/{policy,rule}.rs` (commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`) or pinned against the one spot
 * where this port had to decide something upstream did not.
 */

const POSIX: SourcePlatform = "posix";
const WINDOWS: SourcePlatform = "windows";

function rule(prefix: ReadonlyArray<string>, decision: "allow" | "prompt" | "forbidden"): PrefixRule {
  const [first, ...rest] = prefix;
  return {
    kind: "prefix",
    decision,
    pattern: { first: first ?? "", rest: rest.map((text) => ({ kind: "single" as const, text })) },
  };
}

function policyOf(...rules: ReadonlyArray<PrefixRule>): ExecPolicy {
  return rules.reduce((policy, entry) => withPrefixRule(policy, entry), EMPTY_POLICY);
}

function decide(
  policy: ExecPolicy,
  argv: ReadonlyArray<string>,
  fallback: (args: ReadonlyArray<string>) => "allow" | "prompt" | "forbidden" = () => "prompt",
): string {
  return evaluateExecPolicy(policy, argv, { platform: POSIX, resolveHostExecutables: false }, fallback)
    .decision;
}

test("the most severe matching rule decides, not the last one written", () => {
  assert.equal(strictestOf(["allow", "forbidden", "prompt"]), "forbidden");
  assert.equal(strictestOf([]), undefined, "no matches stays 'undecided' and never 'allowed'");
});

test("individually harmless rules do not add up to permission", () => {
  const policy = policyOf(rule(["git"], "allow"), rule(["git", "push"], "forbidden"));
  assert.equal(decide(policy, ["git", "push", "origin", "main"]), "forbidden");
  assert.equal(decide(policy, ["git", "status"]), "allow");
});

test("a pattern is a prefix: arguments past the end are not constrained", () => {
  const policy = policyOf(rule(["git", "status"], "allow"));
  assert.equal(decide(policy, ["git", "status"]), "allow");
  assert.equal(decide(policy, ["git", "status", "--porcelain", "-uall"]), "allow");
});

test("a shorter command is not covered by a longer rule", () => {
  const policy = policyOf(rule(["git", "status"], "allow"));
  assert.equal(decide(policy, ["git"]), "prompt", "bare `git` was never described by the rule");
});

test("alternative heads expand into one rule per word", () => {
  const parsed = parseExecPolicyDocument(
    {
      rules: [
        {
          pattern: [["add", "commit"], "--verbose"],
          decision: "prompt",
          match: [["add", "--verbose"], ["commit", "--verbose"]],
        },
      ],
    },
    POSIX,
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(decide(parsed.policy, ["add", "--verbose"]), "prompt");
  assert.equal(decide(parsed.policy, ["commit", "--verbose"]), "prompt");
  assert.equal(decide(parsed.policy, ["push", "--verbose"]), "prompt", "fallback asked instead");
});

test("an absolute path answers to a rule written for its basename", () => {
  const policy = policyOf(rule(["python"], "allow"));
  const evaluation = evaluateExecPolicy(
    policy,
    ["/usr/bin/python", "script.py"],
    { platform: POSIX, resolveHostExecutables: true },
    () => "prompt",
  );

  assert.equal(evaluation.decision, "allow");
  const match = evaluation.matchedRules[0];

  assert.equal(match?.kind, "prefix");
  assert.equal(match?.kind === "prefix" ? match.resolvedProgram : undefined, "/usr/bin/python");
});

test("declaring where a program lives narrows rather than widens", () => {
  const policy = {
    ...policyOf(rule(["python"], "allow")),
    hostExecutables: new Map([["python", ["/usr/bin/python"]]]),
  };
  const options = { platform: POSIX, resolveHostExecutables: true } as const;

  assert.equal(
    evaluateExecPolicy(policy, ["/usr/bin/python", "a.py"], options, () => "prompt").decision,
    "allow",
  );
  assert.equal(
    evaluateExecPolicy(policy, ["/tmp/evil/python", "a.py"], options, () => "prompt").decision,
    "prompt",
    "a same-named program elsewhere does not inherit the rule",
  );
});

test("windows executable suffixes and case are folded into one program", () => {
  assert.equal(executableBasename("python.exe", WINDOWS), "python");
  assert.equal(executableBasename("NODE.EXE", WINDOWS), "node");
  assert.equal(executableBasename("C:\\tools\\python.exe", WINDOWS), "python");
  assert.equal(executableBasename("/usr/bin/python", POSIX), "python");
  assert.equal(executableBasename("", WINDOWS), undefined);
});

test("an unmatched command falls through to the caller's own approval facts", () => {
  const policy = policyOf(rule(["ls"], "allow"));
  const seen: Array<ReadonlyArray<string>> = [];
  const decision = evaluateExecPolicy(
    policy,
    ["cargo", "build"],
    { platform: POSIX, resolveHostExecutables: false },
    (argv) => {
      seen.push(argv);
      return "prompt";
    },
  ).decision;

  assert.equal(decision, "prompt");
  assert.deepEqual(seen, [["cargo", "build"]], "the fallback, not this module, owns the answer");
});

test("a policy with no rules never decides a command", () => {
  assert.deepEqual(matchesForCommand(EMPTY_POLICY, ["anything"], { platform: POSIX, resolveHostExecutables: true }), []);
  assert.equal(decide(EMPTY_POLICY, ["anything"], () => "forbidden"), "forbidden");
});

test("merging policies cannot remove a refusal written earlier", () => {
  const base = policyOf(rule(["rm", "-rf"], "forbidden"));
  const overlay = policyOf(rule(["rm", "-rf"], "allow"));
  assert.equal(decide(mergeExecPolicy(base, overlay), ["rm", "-rf", "/"]), "forbidden");
});

test("operator-facing output lists only what is allowed, deduped", () => {
  const policy = policyOf(rule(["git", "status"], "allow"), rule(["rm", "-rf"], "forbidden"));
  assert.deepEqual(allowedPrefixes(policy), [["git", "status"]]);
});

test("every decision word round-trips through the parser", () => {
  for (const decision of EXEC_DECISIONS) {
    const parsed = parseExecPolicyDocument({ rules: [{ pattern: ["ls"], decision }] }, POSIX);
    assert.equal(parsed.ok, true, `${decision} must be accepted`);
  }
});
