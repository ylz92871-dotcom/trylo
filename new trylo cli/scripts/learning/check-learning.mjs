import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createCheckLearningSubsystem } from "../../dist/internal/integration/check-learning/runtime.js";
import { createToolEvolutionVerifier } from "../../dist/internal/adapters/tool-evolution/process-verifier.js";
import { createWindowsIsolation } from "../../dist/internal/adapters/sandbox/windows/windows-isolation.js";
import { windowsHelperEnvironment } from "../../dist/internal/adapters/sandbox/windows/windows-helper-environment.js";

// This explicit operator entry uses the existing confined checker. It never installs or falls back to host execution.
const [boardPath, command, ...args] = process.argv.slice(2);
const inputCommands = new Set(["observe", "check", "feedback"]);
const valid = boardPath && ((command === "status" && args.length === 0)
  || (command === "learn" && args.length === 2 && args[0] === "verifier" && /^\d+$/.test(args[1]) && Number(args[1]) <= 96)
  || (inputCommands.has(command) && args.length === 1));
if (!valid) {
  process.stderr.write("Usage: node scripts/learning/check-learning.mjs <board-root> observe|check|feedback <json-file>\n"
    + "       node scripts/learning/check-learning.mjs <board-root> learn verifier <0..96>\n"
    + "       node scripts/learning/check-learning.mjs <board-root> status\n");
  process.exitCode = 2;
} else {
  const boardRoot = path.resolve(boardPath);
  const verifier = createToolEvolutionVerifier({ isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(process.env) }),
    scratchRoot: path.join(boardRoot, "check-scratch"), nodeExecutable: process.execPath, profile: "confined_json_function_v1" });
  const learning = createCheckLearningSubsystem({ boardRoot, verifier, collect: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();

  process.once("SIGINT", cancel);

  try {
    let input;

    if (inputCommands.has(command)) {
      if ((await stat(args[0])).size > 600 * 1024) throw new Error("input file exceeds the check-learning byte limit");
      input = JSON.parse(await readFile(args[0], "utf8"));
    }

    const result = command === "observe" ? await learning.observe(input)
      : command === "check" ? await learning.checkTask(input, controller.signal)
        : command === "feedback" ? await learning.feedback(input)
          : command === "learn" ? await learning.learn({ subsystem: "verifier", quota: Number(args[1]) }, controller.signal)
            : await learning.inspect();

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "check-learning failed"}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
