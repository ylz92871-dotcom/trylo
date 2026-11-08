import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewTarget, reviewHint, reviewPrompt } from "./review-target.js";

/**
 * WP11.1/11.3 (C75): review target resolution, Codex-ported.
 *
 * Red evidence: new module (import fails pre-WP11). Behavioural red was
 * shown by loosening the conflict check to allow `--uncommitted --base`:
 * `targets conflict with each other` goes red.
 */

test("each target resolves alone", () => {
  assert.deepEqual(parseReviewTarget({ uncommitted: true }), {
    ok: true,
    target: { kind: "uncommitted" },
  });
  assert.deepEqual(parseReviewTarget({ base: "main" }), {
    ok: true,
    target: { kind: "base", branch: "main" },
  });
  assert.deepEqual(parseReviewTarget({ commit: "abc1234", commitTitle: "Fix it" }), {
    ok: true,
    target: { kind: "commit", sha: "abc1234", title: "Fix it" },
  });
  assert.deepEqual(parseReviewTarget({ prompt: "check auth" }), {
    ok: true,
    target: { kind: "custom", instructions: "check auth" },
  });
});

test("targets conflict with each other", () => {
  const outcome = parseReviewTarget({ uncommitted: true, base: "main" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "target_conflict");
  }

  const three = parseReviewTarget({ commit: "abc", prompt: "x" });

  assert.equal(three.ok, false);
});

test("no target names the four options", () => {
  const outcome = parseReviewTarget({});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "target_missing");
    assert.match(outcome.detail, /--uncommitted, --base, --commit/);
  }
});

test("title without commit is refused", () => {
  const outcome = parseReviewTarget({ commitTitle: "orphan" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "title_without_commit");
  }
});

test("prompts match the Codex strings exactly, not by fragment", () => {
  // Exact equality (§4.3): a drifted word must turn this red. Values verified
  // against prompts/src/review_request.rs:18-32,110-124 at HEAD 73a1148c.
  const uncommitted = reviewPrompt({ kind: "uncommitted" });

  assert.equal(uncommitted.ok, true);

  if (uncommitted.ok) {
    assert.equal(
      uncommitted.prompt,
      "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
    );
  }

  const precise = reviewPrompt({ kind: "base", branch: "main" }, "deadbee");

  assert.equal(precise.ok, true);

  if (precise.ok) {
    assert.equal(
      precise.prompt,
      "Review the code changes against the base branch 'main'. The merge base commit for this comparison is deadbee. Run `git diff deadbee` to inspect the changes relative to main. Provide prioritized, actionable findings.",
    );
  }

  const backup = reviewPrompt({ kind: "base", branch: "main" });

  assert.equal(backup.ok, true);

  if (backup.ok) {
    assert.equal(
      backup.prompt,
      "Review the code changes against the base branch 'main'. Start by finding the merge diff between the current branch and main's upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"main@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the main branch. Provide prioritized, actionable findings.",
    );
  }

  const titled = reviewPrompt({ kind: "commit", sha: "abc1234", title: "Fix it" });

  assert.equal(titled.ok, true);

  if (titled.ok) {
    assert.equal(
      titled.prompt,
      'Review the code changes introduced by commit abc1234 ("Fix it"). Provide prioritized, actionable findings.',
    );
  }

  const untitled = reviewPrompt({ kind: "commit", sha: "abc1234" });

  assert.equal(untitled.ok, true);

  if (untitled.ok) {
    assert.equal(
      untitled.prompt,
      "Review the code changes introduced by commit abc1234. Provide prioritized, actionable findings.",
    );
  }

  const missing = parseReviewTarget({});

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.detail, "Specify --uncommitted, --base, --commit, or provide custom review instructions");
  }

  const empty = reviewPrompt({ kind: "custom", instructions: "   " });

  assert.equal(empty.ok, false);

  if (!empty.ok) {
    assert.equal(empty.detail, "Review prompt cannot be empty");
  }
});

test("hints are short human labels", () => {
  assert.equal(reviewHint({ kind: "uncommitted" }), "current changes");
  assert.equal(reviewHint({ kind: "base", branch: "main" }), "changes against 'main'");
  assert.equal(reviewHint({ kind: "commit", sha: "abc123456" }), "commit abc1234");
  assert.equal(reviewHint({ kind: "custom", instructions: "  check auth " }), "check auth");
});
