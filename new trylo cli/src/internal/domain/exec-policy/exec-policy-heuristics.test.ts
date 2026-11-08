import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dangerousCommandMatch,
  parseExecPolicyDocument,
  rmArgsIncludeForce,
  unmatchedCommandDecision,
  type SourcePlatform,
} from "./index.js";

/**
 * The two parts that have teeth (C66/L64).
 *
 * The danger cases are Codex's own test vectors from
 * `shell-command/src/command_safety/is_dangerous_command.rs` (commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`); the loader cases are the reason
 * a policy that does not do what it says cannot be loaded rather than merely
 * being wrong at runtime.
 */

const POSIX: SourcePlatform = "posix";

test("force-delete is recognised however it is spelled", () => {
  for (const argv of [
    ["rm", "-rf", "/"],
    ["rm", "-f", "/"],
    ["/bin/rm", "-fr", "/tmp/example"],
    ["rm", "-r", "-f", "/tmp/example"],
    ["rm", "--force", "/tmp/example"],
    ["rm", "/tmp/example", "-f"],
  ]) {
    assert.equal(dangerousCommandMatch(argv, POSIX), "forced_rm", JSON.stringify(argv));
  }
});

test("a wrapper does not hide the dangerous command underneath it", () => {
  assert.equal(dangerousCommandMatch(["sudo", "rm", "-rf", "/tmp/example"], POSIX), "forced_rm");
  assert.equal(
    dangerousCommandMatch(["env", "TARGET=/tmp/example", "rm", "-rf", "/tmp/example"], POSIX),
    "forced_rm",
  );
});

/**
 * A recorded gap, pinned rather than papered over.
 *
 * Codex reaches inside `trap '<action>'` — and inside `bash -lc "<script>"` —
 * by parsing the shell source itself. That parser is not part of this port, so
 * a dangerous command living inside one argument *string* is not recognised
 * here. It stays a failing expectation on purpose: closing the gap means porting
 * the literal-command expansion, not relaxing this line. Until then the shell
 * boundary refuses operators before this layer is consulted, and the escalation
 * path asks a human about anything the policy does not cover.
 */
test("a dangerous command hidden inside one shell-source argument is not recognised (known gap)", () => {
  assert.equal(dangerousCommandMatch(["trap", "rm -rf /tmp/example", "EXIT"], POSIX), undefined);
  assert.equal(dangerousCommandMatch(["bash", "-lc", "rm -rf /tmp/example"], POSIX), undefined);
});

test("-- ends the option section, so `rm -- -f` deletes a file called -f", () => {
  assert.equal(rmArgsIncludeForce(["--", "-f"]), false);
  assert.equal(dangerousCommandMatch(["rm", "--", "-f"], POSIX), undefined);
});

test("a deletion the operator can be asked about is not a danger signal", () => {
  for (const argv of [
    ["rm", "-r", "/tmp/example"],
    ["env", "TARGET=/tmp/example", "rm", "-r", "/tmp/example"],
  ]) {
    assert.equal(dangerousCommandMatch(argv, POSIX), undefined, JSON.stringify(argv));
  }
});

test("wrappers past the depth cap fail closed instead of failing open", () => {
  const atCap = ["env", "env", "env", "env", "env", "env", "env", "env", "rm", "-rf", "/tmp/x"];
  const overCap = [...atCap.slice(0, 8), "env", "env", "rm", "-rf", "/tmp/x"];

  assert.equal(dangerousCommandMatch(atCap, POSIX), "forced_rm");
  assert.equal(
    dangerousCommandMatch(overCap, POSIX),
    "other",
    "a command too deep to understand is dangerous, not unexamined-but-fine",
  );
});

test("a command nobody owns is refused in a non-interactive run", () => {
  assert.equal(
    unmatchedCommandDecision({ dangerous: false, posture: "never", requestsSandboxOverride: false }),
    "forbidden",
    "upstream answers `allow` here only because a real OS sandbox is behind it; this package has none",
  );
});

test("danger asks a person whenever there is a person to ask", () => {
  assert.equal(
    unmatchedCommandDecision({ dangerous: true, posture: "on_request", requestsSandboxOverride: false }),
    "prompt",
  );
  assert.equal(
    unmatchedCommandDecision({ dangerous: true, posture: "unless_trusted", requestsSandboxOverride: false }),
    "prompt",
  );
  assert.equal(
    unmatchedCommandDecision({ dangerous: true, posture: "never", requestsSandboxOverride: false }),
    "forbidden",
    "nobody to ask, so the answer is no rather than yes",
  );
});

test("asking for a sandbox relaxation is asking", () => {
  assert.equal(
    unmatchedCommandDecision({ dangerous: false, posture: "on_request", requestsSandboxOverride: true }),
    "prompt",
  );
  assert.equal(
    unmatchedCommandDecision({ dangerous: false, posture: "on_request", requestsSandboxOverride: false }),
    "allow",
  );
});

function failuresFor(source: Parameters<typeof parseExecPolicyDocument>[0]): ReadonlyArray<string> {
  const parsed = parseExecPolicyDocument(source, POSIX);
  assert.equal(parsed.ok, false, "this policy must be refused");
  return parsed.ok ? [] : parsed.failures.map((failure) => failure.message);
}

test("a rule whose own example does not match cannot be loaded", () => {
  const messages = failuresFor({
    rules: [{ pattern: ["git", "status"], decision: "allow", match: [["git", "diff"]] }],
  });
  assert.match(messages.join("\n"), /match example .* is not matched/);
});

test("a rule that matches what it claims not to cannot be loaded", () => {
  const messages = failuresFor({
    rules: [{ pattern: ["git"], decision: "allow", notMatch: [["git", "status"]] }],
  });
  assert.match(messages.join("\n"), /not_match example .* is matched/);
});

test("a typo in the decision is a load failure, not a default", () => {
  const messages = failuresFor({ rules: [{ pattern: ["ls"], decision: "disallow" }] });
  assert.match(messages.join("\n"), /decision must be one of/);
});

test("an empty or blank justification is refused rather than stored", () => {
  assert.match(failuresFor({ rules: [{ pattern: ["ls"], decision: "allow", justification: "   " }] }).join("\n"), /justification cannot be empty/);
  const ok = parseExecPolicyDocument(
    { rules: [{ pattern: ["ls"], decision: "allow", justification: "reading is safe" }] },
    POSIX,
  );
  assert.equal(ok.ok, true);
});

test("a pattern must describe at least one word", () => {
  assert.match(failuresFor({ rules: [{ pattern: [], decision: "allow" }] }).join("\n"), /pattern cannot be empty/);
  assert.match(failuresFor({ rules: [{ pattern: [[]], decision: "allow" }] }).join("\n"), /alternatives cannot be empty/);
});

test("host executables must be absolute paths to the program they name", () => {
  assert.match(
    failuresFor({ rules: [], hostExecutables: [{ name: "python", paths: ["bin/python"] }] }).join("\n"),
    /must be absolute/,
  );
  assert.match(
    failuresFor({ rules: [], hostExecutables: [{ name: "python", paths: ["/usr/bin/python3"] }] }).join("\n"),
    /must have basename/,
  );
  assert.match(
    failuresFor({ rules: [], hostExecutables: [{ name: "tools/python", paths: ["/usr/bin/python"] }] }).join("\n"),
    /bare executable name/,
  );
});
