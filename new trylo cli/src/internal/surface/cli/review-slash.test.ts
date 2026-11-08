import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../../ports/session.js";
import { slashDiffText, slashReviewText, slashRollbackText } from "./review-slash.js";
import type { GitCommandResult } from "./git-diff.js";

/**
 * WP11.3: `/diff`, `/review`, `/rollback` slash bodies.
 *
 * Red evidence: new module (import fails pre-WP11). Behavioural red was
 * shown by returning the newest turn for any numeric arg: `numeric args
 * address user messages` goes red.
 */

const AT = "2026-10-05T00:00:00.000Z";

function user(turnId: string, text: string, sequence: number): SessionRecord {
  return {
    formatVersion: "1",
    sequence,
    type: "transcript_item",
    sessionId: "s1",
    turnId,
    at: AT,
    payload: { kind: "user", sequence: 0, text },
  } as SessionRecord;
}

test("/diff reports outside-git-repos instead of failing", async () => {
  const text = await slashDiffText({
    cwd: "/work",
    platform: "posix",
    env: {},
    runner: {
      async run(): Promise<GitCommandResult> {
        return { exit: 128, stdout: "", stderr: "not a git repo" };
      },
    },
  });
  assert.match(text, /not a git repository/);
});

test("/diff prints the collected diff", async () => {
  const text = await slashDiffText({
    cwd: "/work",
    platform: "posix",
    env: {},
    runner: {
      async run(argv): Promise<GitCommandResult> {
        if (argv.includes("--others")) {
          return { exit: 0, stdout: "", stderr: "" };
        }

        if (argv.includes("rev-parse") || argv.includes("--get-regexp")) {
          return { exit: argv.includes("rev-parse") ? 0 : 1, stdout: "", stderr: "" };
        }

        return { exit: 1, stdout: "--- a/f.ts\n", stderr: "" };
      },
    },
  });
  assert.match(text, /--- a\/f\.ts/);
});

test("bare /review shows the latest turn; numeric args address user messages", () => {
  const records = [user("t1", "first", 0), user("t2", "second", 1)];
  const latest = slashReviewText(records, "");

  assert.match(latest, /turn t2/);
  const first = slashReviewText(records, "1");

  assert.match(first, /turn t1/);
  assert.match(first, /first/);
  assert.match(slashReviewText(records, "9"), /out of range/);
  assert.match(slashReviewText(records, "nope"), /no such turn/);
  assert.match(slashReviewText(undefined, ""), /no journal/);
});

test("/rollback previews the horizon and names the fork", async () => {
  const records = [user("t1", "first", 0), user("t2", "second", 1)];
  // The horizon sits strictly before the message (F8): rolling back to the
  // second message keeps the first one visible.
  const text = slashRollbackText(records, "s1", "2");

  assert.match(text, /horizon 0/);
  assert.match(text, /would see 1 item\(s\), 1 hidden/);
  assert.match(text, /trylo session fork s1 --before-user-message 2/);
  assert.match(text, /journal is unchanged/);
  // Rolling back to the very first message keeps no transcript items.
  const empty = slashRollbackText(records, "s1", "1");

  assert.match(empty, /nothing precedes it/);
  assert.match(empty, /--before-user-message 1/);
  assert.match(slashRollbackText(records, "s1", ""), /usage: \/rollback/);
  assert.match(slashRollbackText(undefined, "s1", "1"), /no journal/);
});
