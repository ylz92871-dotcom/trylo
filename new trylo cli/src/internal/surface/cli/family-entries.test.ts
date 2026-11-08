import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { parseArgs } from "./args.js";
import { FAMILY_COMMAND_WORDS } from "./command-vocabulary.js";
import { main } from "../../../cmd/trylo/main.js";

/**
 * A family verb must be recognised by the *parser* and answered by the real entry
 * point — not by a bypass in front of it.
 *
 * ## Why both directions are pinned
 *
 * A routing hook fails two ways: claim too little and the verb is unreachable;
 * claim too much and unknown words get swallowed so nobody hears "unknown command".
 * `schedule-entry.ts` sat unwired for a whole review round with every family test
 * green, and the daemon's launch target pointed at a missing file while the
 * lifecycle probes passed — the pattern this file exists to break.
 */

function lab(): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-family-"));
  const home = join(root, "home");

  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd: root,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        // A missing record file is an answer ("nothing scheduled"), not a crash.
        return undefined;
      }
    },

    isDirectory: () => false,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}_1`,
  };

  return { ctx, out, err };
}

test("the parser itself claims every family word", () => {
  for (const word of FAMILY_COMMAND_WORDS) {
    const parsed = parseArgs([word, "list"]);
    assert.equal(parsed.kind, "family", `parseArgs did not claim "${word}"`);
    if (parsed.kind !== "family") continue;
    assert.equal(parsed.word, word);
    assert.deepEqual(parsed.args, ["list"], "the family gets argv past its own word");
  }
});

test("words the root parses are not handed to a family", () => {
  for (const argv of [["session", "list"], ["run", "hi"], ["queue", "list"], ["providers", "list"]]) {
    const parsed = parseArgs(argv);
    assert.notEqual(parsed.kind, "family", `${argv.join(" ")} is the root's own verb`);
  }
});

test("a global switch is refused before a family sees it", () => {
  // The old bypass asked families first, so `--learning on schedule list` reached
  // the schedule parser with the switch quietly dropped. Refusing is the same
  // answer the root gives for every other verb that cannot honour it.
  const parsed = parseArgs(["--learning", "method", "schedule", "list"]);

  assert.equal(parsed.kind, "error");

  if (parsed.kind !== "error") return;

  assert.match(parsed.message, /does not accept --learning/);
});

test("`schedule` and `daemon` and `bg` are reachable through the real entry point", async () => {
  const h = lab();

  assert.equal(await main(["schedule", "list"], h.ctx), EXIT_CODES.OK);
  assert.ok(h.out.join("").length > 0);

  const d = lab();

  assert.equal(await main(["daemon", "--help"], d.ctx), EXIT_CODES.OK);
  assert.match(d.out.join(""), /trylo daemon/);

  const b = lab();

  assert.equal(await main(["bg", "ps"], b.ctx), EXIT_CODES.OK);
  assert.match(b.out.join(""), /no background jobs/);
});

test("an unknown word is still the root's answer, not the family's silence", async () => {
  const h = lab();
  const code = await main(["nonsense"], h.ctx);
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(h.err.join(""), /unknown command: nonsense/);
});

test("`trylo --help` names the verbs the families own", async () => {
  // Their verbs are not in the root's own parser branches, so if `usage.ts` stops
  // listing them the most findable commands disappear from the menu.
  const h = lab();
  const code = await main(["--help"], h.ctx);
  const text = h.out.join("");

  assert.equal(code, EXIT_CODES.OK);
  assert.match(text, /trylo session list/, "the root's own help must still be there");

  for (const word of FAMILY_COMMAND_WORDS) {
    assert.match(text, new RegExp(`trylo ${word}`), `help is missing ${word}`);
  }
});
