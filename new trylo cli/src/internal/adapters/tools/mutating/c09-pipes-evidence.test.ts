import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hostShellEnvironment } from "../../sandbox/executable.js";
import { NODE, cleanup, run, stderrOf, stdoutOf, workspace } from "./c09-harness.js";

/**
 * WP05.2, the data half: what a command's words and its bytes actually become.
 *
 * The composition suite proves the SHAPE of what reaches the spawner with a
 * recording double. This file is the other half for the same path with
 * `createNodeSpawner`: stdout, stderr, exit code, cwd, env and argv observed
 * rather than asserted about a mock. WP05.2's acceptance names the cases —
 * spaces, non-ASCII, a non-zero exit — so each is here as its own test with the
 * disk checked afterwards.
 *
 * The process half (what can be started at all, PATH, batch files, the
 * environment allowlist) is in `c09-process-evidence.test.ts`; the rig both files
 * share, and the measured reason each part of it exists, is in
 * `c09-harness.ts`.
 */

test("stdout and exit code arrive from a real process", async () => {
  const root = workspace({ "emit.js": "process.stdout.write('alpha beta gamma');\n" });
  try {
    const outcome = await run(root, `${NODE} emit.js`);
    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    if (outcome.outcome === "result") {
      assert.equal(outcome.value.exitCode, 0);
      assert.equal(outcome.value.stdout, "alpha beta gamma");
    }
  } finally {
    cleanup(root);
  }
});

test("a command with spaces and non-ASCII text survives to a real file", async () => {
  // WP05.2 names spaces and 中文 explicitly. The evidence is the file on disk,
  // not the echo of it: a round-trip through a pipe would also pass if the bytes
  // were mangled in a way the writer did not notice.
  //
  // The payload is one line on purpose. A real newline in the command is a
  // refusal the tool makes for a good reason — it runs one command per call —
  // so a multi-line argument is not something to smuggle past here; the newline
  // content itself is covered by the next test, through a file.
  const root = workspace({
    "write-args.js": "require('fs').writeFileSync(process.argv[2], process.argv[3], 'utf8');\n",
  });
  try {
    const target = path.join(root, "空 格 文件.txt");
    const payload = "第一行 ascii with spaces 与第二行的等号 = 123";
    const outcome = await run(root, `${NODE} write-args.js "${target}" "${payload}"`);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    assert.equal(existsSync(target), true, "the file the command named was not created");
    // Byte-for-byte, so a mojibake or a dropped space fails here.
    assert.equal(readFileSync(target, "utf8"), payload);
  } finally {
    cleanup(root);
  }
});

test("multi-line content round-trips when it travels as a file, not as a command", async () => {
  // The same bytes, the other way. A newline cannot go through the command
  // string — `shell_operator_forbidden` says so by design — so the supported
  // route is the one the refusal itself names: write the script, run the file.
  // This is that route end to end, with the disk checked on both sides.
  const root = workspace({
    "copy.js": "require('fs').copyFileSync(process.argv[2], process.argv[3]);\n",
  });
  try {
    const source = path.join(root, "多行 source.txt");
    const target = path.join(root, "多行 target.txt");
    const body = "第一行 ascii with spaces\n第二行 中文与English混排 123\n第三行 back\\slash and \"quotes\"\n";

    writeFileSync(source, body, "utf8");
    const outcome = await run(root, `${NODE} copy.js "${source}" "${target}"`);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    assert.equal(readFileSync(target, "utf8"), body);
  } finally {
    cleanup(root);
  }
});

test("a newline in the command is refused, and the refusal names the way out", async () => {
  // Stated as a test because the previous test's payload had to avoid it. The
  // message is the contract: a model that hits this has to be told what to do
  // instead, or it retries the same way.
  const root = workspace();
  try {
    const outcome = await run(root, `${NODE} emit.js\n${NODE} emit.js`);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_operator_forbidden");
      assert.match(outcome.message, /write_file/);
    }
  } finally {
    cleanup(root);
  }
});

test("argv reaches the program as separate, whole arguments", async () => {
  // The no-shell property stated as evidence: a path with a space arrives as one
  // argument, because the tokenizer produced one word and nothing re-split it.
  const root = workspace({ "argv.js": "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n" });
  try {
    const spaced = path.join(root, "a b c.txt");
    const outcome = await run(root, `${NODE} argv.js "${spaced}" "空 格" x`);
    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    assert.deepEqual(JSON.parse(stdoutOf(outcome)) as string[], [spaced, "空 格", "x"]);
  } finally {
    cleanup(root);
  }
});

test("cwd is the directory asked for, and a file written there lands there", async () => {
  // The script sits in the directory the command is asked to run in, and the
  // program is the launcher named bare so PATH finds it. Three things are
  // asserted at once, because together they are the contract and apart they are
  // each trivially true:
  //
  //  - `cwd` really is the child's working directory. The evidence is the
  //    child's own `process.cwd()`: "the file landed there" cannot tell a real
  //    cwd from a path that merely looks right.
  //  - a relative argument arrives UNRESOLVED. `where.js` has to reach the child
  //    as `where.js`, or a child sitting in `nested dir` could not load the file
  //    the workspace root does contain. This is the shape that fails loudly —
  //    the error is node's `Cannot find module '<cwd>\where.js'`, which names
  //    the working directory in the refusal.
  //  - the program is still found on PATH even though the cwd moved, so the
  //    workspace does not resolve a bare name against itself.
  const root = workspace();
  try {
    const nested = path.join(root, "nested dir");

    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(nested, "where.js"),
      [
        "require('fs').writeFileSync('where.txt', process.cwd());",
        "process.stdout.write(process.cwd());",
        "",
      ].join("\n"),
      "utf8",
    );
    const outcome = await run(root, `${NODE} where.js`, { cwd: "nested dir" });

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    assert.equal(stdoutOf(outcome), nested);
    assert.equal(readFileSync(path.join(nested, "where.txt"), "utf8"), nested);
    assert.equal(existsSync(path.join(root, "where.txt")), false, "it must not land in the workspace root");
  } finally {
    cleanup(root);
  }
});

test("a non-zero exit is the tool's failure, with the code and the output", async () => {
  const root = workspace({ "fail.js": "process.stderr.write('boom happened'); process.exit(17);\n" });
  try {
    const outcome = await run(root, `${NODE} fail.js`);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_nonzero_exit");
      assert.match(outcome.message, /17/);
      // The output is the evidence a model acts on, so it has to be in there.
      assert.match(outcome.message, /boom happened/);
    }
  } finally {
    cleanup(root);
  }
});

test("stdout and stderr stay separate, and a pipeline reports its last stage", async () => {
  // Stage one writes to stderr, stage two to stdout: if the spawner merged
  // them, the second stage's input would carry stage one's diagnostics.
  const root = workspace({
    "produce.js": "process.stderr.write('note'); process.stdout.write('payload');\n",
    "consume.js":
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('got:'+s.trim()));\n",
  });
  try {
    const outcome = await run(root, `${NODE} produce.js | ${NODE} consume.js`);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.stdout, "got:payload");
      // stderr of every segment is merged, because a failure in any of them is
      // worth seeing; stdout is the last stage's alone, which is what a shell
      // reports too.
      assert.equal(stderrOf(outcome).includes("note"), true);
      assert.equal(outcome.value.exitCode, 0);
    }
  } finally {
    cleanup(root);
  }
});

test("a pipeline's exit code is the last stage's, and a failing stage shows up", async () => {
  const root = workspace({
    "produce.js": "process.stdout.write('x');\n",
    "fail3.js": "process.exit(3);\n",
  });
  try {
    const outcome = await run(root, `${NODE} produce.js | ${NODE} fail3.js`);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_nonzero_exit");
      assert.match(outcome.message, /3/);
    }
  } finally {
    cleanup(root);
  }
});

/**
 * A single fact, asserted so the other suite's environment checks are not
 * passing by accident: the environment these commands ran in came from this
 * machine. The allowlist half is in `c09-process-evidence.test.ts`.
 */
test("the host record the spawner resolves under is the real one", () => {
  const host = hostShellEnvironment();
  assert.equal(host.platform, process.platform);
  assert.equal(host.env["PATH"], process.env["PATH"]);
});
