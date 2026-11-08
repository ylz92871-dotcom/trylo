import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPtySessionRegistry } from "./pty-session.js";

/**
 * WP08 S5 —— `trylo queue` 在真 ConPTY 里跑一次（不是模拟）。
 *
 * **为什么这个文件存在而不是一条命令。** 真终端上的失败和管道里的失败长得
 * 不一样：`pty_session_not_found` 这种"会话刚起就没了"只在真控制台里出现过，
 * 而它无法用一个 fake registry 造出来——fake 会照抄生产代码的假设。
 * 所以这里跑真的 sidecar、真的 node.exe、真的 dist CLI，只把断言放在"屏幕上
 * 出现了什么"这一层。
 *
 * **raw mode 与 echo 不在这个文件里，因为这个 build 没有它们。**
 * `tui/io.ts` 明写 "adds no raw-mode switches"，`tui/discipline.test.ts` 把
 * `setRawMode` 列为禁令；行编辑走 `node:readline` 的 cooked mode。把它们记成
 * "待验证"会让人以为还有一条路径没修，而实际上没有这条路径。
 */
const CLI = process.env["TRYLO_TTY_CLI"];
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const systemRoot = process.env["SystemRoot"] ?? "C:/Windows";

/**
 * The four keys a Windows loader needs, plus `TRYLO_HOME` so the probe writes
 * to a scratch directory instead of the developer's real `~/.trylo`. Nothing
 * else is passed: the sidecar clears the environment on purpose, and every key
 * added here is one more thing that has to be right on every machine.
 *
 * The scratch home is **not** cleaned between cases, and `TRYLO_HOME` outlives
 * the process: a queue file written by an earlier run is still there on the
 * next one. So the scratch is per-case too — sharing it made the first case
 * assert "nothing queued" against a queue the second case of the *previous* run
 * had filled, which is a red that says nothing about the code under test.
 */
function childEnv(home: string): Readonly<Record<string, string>> {
  return {
    PATH: (process.env["PATH"] ?? "").split(path.delimiter).filter((e) => e.length > 0).join(path.delimiter),
    SystemRoot: systemRoot,
    TEMP: process.env["TEMP"] ?? "",
    COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    TRYLO_HOME: home,
  };
}

/** A scratch home and session id no other run can collide with. */
function freshTarget(): { readonly home: string; readonly sessionId: string } {
  const tag = randomUUID();
  return {
    home: path.join(process.env["TEMP"] ?? ".", `trylo-tty-${tag}`),
    sessionId: `tty-${tag}`,
  };
}

/** Strips the control sequences a console adds, so a claim is about the words. */
function visible(output: string): string {
  return output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
}

async function readAll(
  registry: ReturnType<typeof createPtySessionRegistry>,
  sessionId: string,
  attempts = 120,
): Promise<{ readonly output: string; readonly status: string }> {
  let output = "";
  let status = "running";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await registry.write({ sessionId, input: "", eof: false, yieldMs: 250 });
    if (read.ok) {
      output += read.read.output;
    }

    const current = registry.get(sessionId);

    status = current?.status ?? "gone";

    // A console child answers with mode-set sequences (ESC[?9001h and friends)
    // before it has produced a word, so "saw bytes" is not "finished".
    if (status !== "running") {
      break;
    }

    await sleep(150);
  }

  return { output, status };
}

const enabled = CLI !== undefined && CLI.length > 0;

test(
  "trylo queue works on a real console, with the console's own exit",
  { skip: enabled ? false : "set TRYLO_TTY_CLI to the built dist/cmd/trylo/main.js" },
  async () => {
    const { home, sessionId } = freshTarget();
    const registry = createPtySessionRegistry();

    try {
      const session = await registry.start({
        id: "",
        argv: [process.execPath, CLI as string, "queue", "list", "--session", sessionId],
        cwd: process.cwd(),
        env: childEnv(home),
        tty: true,
        rows: 30,
        cols: 100,
        maxBufferBytes: 65_536,
      });

      assert.equal(session.tty, true, "this path claims a terminal and must not quietly be a pipe");

      const { output, status } = await readAll(registry, session.id);

      // Recorded rather than asserted first: the failure this probe exists for
      // produced zero bytes and a dead session, and a bare `assert.match` on the
      // text would hide which of the two happened.
      console.log(`TTY status=${status} raw=${output.length} visible=${JSON.stringify(visible(output))}`);
      console.log(`TTY RAW BYTES=${JSON.stringify(output)} CODES=${[...output].map((c)=>c.charCodeAt(0)).join(",")}`);
      console.log(`TTY end=${JSON.stringify(registry.get(session.id)?.end ?? null)}`);
      assert.equal(status, "exited", `the console session ended as ${status}, not by running the CLI to completion`);
      // The id is in the sentence on purpose: an empty queue has to name the
      // queue it just looked at, or "nothing queued" is just some empty list.
      assert.match(visible(output), new RegExp(`nothing queued for session ${sessionId}`));
      // A pipe carries the program's bytes; a console adds cursor sequences.
      // This is the assertion that says "it really was a terminal".
      assert.match(output, /\x1b\[/, "no ANSI in the output, so this did not go through a console");
      assert.equal(registry.get(session.id)?.exitCode, 0, "the CLI's own exit code, through the terminal");
    } finally {
      registry.shutdown();
    }
  },
);

test(
  "a message queued from one console is listed by the next",
  { skip: enabled ? false : "set TRYLO_TTY_CLI" },
  async () => {
    const { home, sessionId } = freshTarget();
    // Unique text per run: a fixed sentence left over from an earlier run would
    // make this assertion pass without the writer and the reader ever meeting.
    const message = `queued-by-a-real-console-${randomUUID()}`;
    const registry = createPtySessionRegistry();
    const run = async (args: ReadonlyArray<string>): Promise<string> => {
      const session = await registry.start({
        id: "",
        argv: [process.execPath, CLI as string, ...args],
        cwd: process.cwd(),
        env: childEnv(home),
        tty: true,
        rows: 30,
        cols: 100,
        maxBufferBytes: 65_536,
      });
      const { output } = await readAll(registry, session.id);

      return visible(output);
    };

    try {
      // Two sessions, in sequence, in the same console family. This is the
      // property C41 exists for: the writer and the reader are different
      // processes and only share a path.
      const added = await run(["queue", "add", "--session", sessionId, "--message", message]);

      console.log(`TTY add=${JSON.stringify(added)}`);
      assert.match(added, new RegExp(`queued for session ${sessionId} as q-`));
      const listed = await run(["queue", "list", "--session", sessionId]);

      console.log(`TTY list=${JSON.stringify(listed)}`);
      assert.match(listed, new RegExp(message));
    } finally {
      registry.shutdown();
    }
  },
);
