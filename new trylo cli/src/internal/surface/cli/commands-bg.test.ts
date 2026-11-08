import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { BackgroundJobRecord, JobStore } from "../../ports/background-job.js";
import { createJobStore } from "../../adapters/process-session/job-store.js";
import type { JobLiveness } from "./commands-bg.js";
import { handleBackground, parseBackground } from "./commands-bg.js";

/**
 * `trylo bg` over the durable job table.
 *
 * The point of every case below is that the CLI reads **the disk**, not a
 * registry: a second terminal has no in-process sessions, and the verbs used to
 * answer "no background sessions" because of it. The other half is what a reader
 * may not claim — an exit code nobody observed, or a signal sent to a pid the
 * process table could not confirm.
 */

let counter = 0;

function lab(
  liveness: JobLiveness | ((record: BackgroundJobRecord) => JobLiveness) = "alive",
  options: { readonly readMaxBytes?: number } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-bg-"));
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
  const jobs: JobStore = createJobStore({
    home: join(home, ".trylo"),
    now: () => 1_700_000_000_000,
    maxLogBytes: 4_096,
    ...(options.readMaxBytes === undefined ? {} : { readMaxBytes: options.readMaxBytes }),
  });
  const killed: number[] = [];
  const sessionId = () => `ps_${(++counter).toString(16).padStart(24, "0")}`;
  const start = (id = sessionId(), pid = 900 + counter) => {
    assert.equal(jobs.publish({ id, pid, command: "node -e slow", cwd: root, startedAtMs: 1_700_000_000_000 }), true);
    return { id, pid };
  };
  const deps = {
    jobs,
    liveness: async (record: BackgroundJobRecord): Promise<JobLiveness> =>
      typeof liveness === "function" ? liveness(record) : liveness,

    killPid: async (pid: number) => {
      killed.push(pid);
      return { ok: true as const, how: "killed" as const };
    },
  };

  return { ctx, out, err, jobs, deps, start, sessionId, killed, record: (id: string) => JSON.parse(readFileSync(join(home, ".trylo", "jobs", id, "job.json"), "utf8")) as BackgroundJobRecord };
}

test("`ps` on an empty table says so, and does not invent a session list", async () => {
  const h = lab();
  const code = await handleBackground(h.ctx, parseBackground(["ps"]), h.deps);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(h.out.join(""), /no background jobs/);
});

test("`ps` reads the disk: a job published by another process is listed", async () => {
  const h = lab();
  const { id, pid } = h.start();
  const code = await handleBackground(h.ctx, parseBackground(["ps"]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  assert.match(h.out.join(""), new RegExp(id));
  assert.match(h.out.join(""), new RegExp(`pid ${pid}`));
  assert.match(h.out.join(""), /node -e slow/);
});

test("`ps` marks a gone job lost and still writes no exit code", async () => {
  const h = lab("gone");
  const { id } = h.start();

  await handleBackground(h.ctx, parseBackground(["ps"]), h.deps);
  assert.match(h.out.join(""), /lost \(no exit code was observed\)/);
  const record = h.record(id);

  assert.equal(record.status, "lost");
  assert.equal("exitCode" in record, false, "the reader did not see the ending");
  assert.equal("endedAtMs" in record, false);
});

test("`ps` says out loud when the process table would not answer", async () => {
  const h = lab("unverifiable");
  h.start();
  await handleBackground(h.ctx, parseBackground(["ps"]), h.deps);
  assert.match(h.out.join(""), /identity unverifiable/);
});

test("a malformed id is refused with the shape, not a bare lookup failure", () => {
  const parsed = parseBackground(["ps", "not-an-id"]);
  assert.equal(parsed.verb, "error");
  if (parsed.verb !== "error") return;
  assert.match(parsed.message, /not a session id/);
  assert.match(parsed.hint, /ps_/);
});

test("`logs` prints what the owner wrote", async () => {
  const h = lab();
  const { id } = h.start();

  h.jobs.append(id, Buffer.from("first line\nsecond line\n"));
  const code = await handleBackground(h.ctx, parseBackground(["logs", id]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  assert.match(h.out.join(""), /first line/);
  assert.match(h.out.join(""), /second line/);
});

test("`logs` for a job with no record is a refusal, not empty success", async () => {
  const h = lab();
  const code = await handleBackground(h.ctx, parseBackground(["logs", h.sessionId()]), h.deps);
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(h.err.join(""), /no job record/);
});

test("`kill` signals the recorded pid and leaves the ending to the observer", async () => {
  const h = lab();
  const { id, pid } = h.start();
  const code = await handleBackground(h.ctx, parseBackground(["kill", id]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  assert.deepEqual(h.killed, [pid]);
  // The killer never saw the child exit, so it must not write what it did not see.
  const record = h.record(id);

  assert.equal(record.status, "running");
  assert.equal("exitCode" in record, false);
});

test("`kill` refuses to signal a pid it cannot confirm", async () => {
  const h = lab("unverifiable");
  const { id } = h.start();
  const code = await handleBackground(h.ctx, parseBackground(["kill", id]), h.deps);
  assert.equal(code, EXIT_CODES.TEMPORARY);
  assert.deepEqual(h.killed, [], "an unverified pid must not be signalled");
  assert.match(h.err.join(""), /nothing was signalled/);
});

test("`kill` on a finished job is the state asked for, not a failure", async () => {
  const h = lab();
  const { id } = h.start();
  h.jobs.settle(id, { kind: "exited", exitCode: 0 });
  const code = await handleBackground(h.ctx, parseBackground(["kill", id]), h.deps);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(h.out.join(""), /was not running \(exited\)/);
});

test("`attach` says it is watching and not taking over", async () => {
  const h = lab();
  const { id } = h.start();

  h.jobs.append(id, Buffer.from("output while nobody looked\n"));
  const code = await handleBackground(h.ctx, parseBackground(["attach", id]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  assert.match(h.out.join(""), /output while nobody looked/);
  assert.match(h.err.join(""), /watching only/);
});

test("`bg --help` states the attach limits in so many words", async () => {
  // The negative semantics are the contract: no stdin, no resize, no owner
  // transfer, and interaction stays in the terminal that started the job.
  // If the help stops saying any of them, `attach` starts implying a
  // takeover it cannot perform.
  const h = lab();
  const code = await handleBackground(h.ctx, parseBackground(["--help"]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  const text = h.out.join("");

  assert.match(text, /watch its output only \(no stdin, no resize, no owner transfer\)/);
  assert.match(text, /To type into a job, use the terminal that started it/);
});

test("`attach --json` carries truncatedFromStart like `logs --json` does", async () => {
  // `logs --json` already answers `{id,status,output,truncatedFromStart}`. An
  // `attach --json` without the flag is a second vocabulary for the same fact:
  // a tail that starts mid-stream and looks complete.
  const h = lab();
  const { id } = h.start();

  h.jobs.append(id, Buffer.from("hello\n"));
  const code = await handleBackground(h.ctx, parseBackground(["attach", id, "--json"]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  const decoded = JSON.parse(h.out.join("")) as {
    readonly id: string;
    readonly status: string;
    readonly output: string;
    readonly truncatedFromStart: boolean;
  };

  assert.equal(decoded.id, id);
  assert.equal(decoded.output, "hello\n");
  assert.equal(decoded.truncatedFromStart, false);
});

test("`attach --json` says truncatedFromStart when the log exceeds the read cap", async () => {
  // Same rule as `logs`: when the file holds more than one read returns, the
  // answer is a tail and must say so, or a reader concludes the program printed
  // only the tail.
  const h = lab("alive", { readMaxBytes: 8 });
  const { id } = h.start();

  h.jobs.append(id, Buffer.from("0123456789abcdef\n"));
  const code = await handleBackground(h.ctx, parseBackground(["attach", id, "--json"]), h.deps);

  assert.equal(code, EXIT_CODES.OK);
  const decoded = JSON.parse(h.out.join("")) as {
    readonly id: string;
    readonly output: string;
    readonly truncatedFromStart: boolean;
  };

  assert.equal(decoded.truncatedFromStart, true);
});
