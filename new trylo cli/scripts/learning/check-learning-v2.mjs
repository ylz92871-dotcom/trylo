import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// An explicit task-owner management entry, sharing the CLI's process context, home, credentials and permission policy.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const compiledFlag = args.indexOf("--compiled-root");
const compiledOverride = compiledFlag < 0 ? undefined : args[compiledFlag + 1];
const invalidCompiled = compiledFlag >= 0 && (!compiledOverride || compiledOverride.startsWith("--") || args.lastIndexOf("--compiled-root") !== compiledFlag);
const compiled = compiledOverride === undefined ? path.join(root, "dist") : path.resolve(compiledOverride);

if (compiledFlag >= 0) args.splice(compiledFlag, 2);

const [command, ...tail] = args;
let operation;

if (!invalidCompiled && (command === "status" || command === "recover") && tail.length === 0) operation = { action: command };
else if (!invalidCompiled && (command === "capture" || command === "feedback") && tail.length === 1) operation = { action: command, file: path.resolve(tail[0]) };
else if (!invalidCompiled && command === "learn" && tail[0] === "check") {
  const { parseArgs } = await import(pathToFileURL(path.join(compiled, "internal/surface/cli/args.js")).href);
  const parsed = parseArgs(["learn", ...tail]);
  if (parsed.kind === "learn" && parsed.options.subsystem === "check" && parsed.options.action === "learn") operation = parsed.options;
}

if (operation === undefined || (compiledFlag >= 0 && args.includes("--compiled-root"))) {
  process.stderr.write("Usage: node scripts/learning/check-learning-v2.mjs status|recover\n"
    + "       node scripts/learning/check-learning-v2.mjs capture|feedback <request.json>\n"
    + "       node scripts/learning/check-learning-v2.mjs learn check --budget <0..32> --tokens <0..262144> --executions <0..256>\n");
  process.exitCode = 2;
} else {
  const { createProcessContext } = await import(pathToFileURL(path.join(compiled, "cmd/trylo/main.js")).href);
  const { runCheckLearningOperation } = await import(pathToFileURL(path.join(compiled, "internal/surface/cli/commands-check-learning.js")).href);
  const { observeRunCancellation } = await import(pathToFileURL(path.join(compiled, "internal/surface/cli/run-interrupt.js")).href);
  const context = createProcessContext();
  const cancellation = observeRunCancellation(context);

  try {
    if ("file" in operation) {
      if ((await stat(operation.file)).size > 262144) throw new Error("request_capacity");
      operation = { action: operation.action, value: JSON.parse(await readFile(operation.file, "utf8")) };
    }

    const result = await runCheckLearningOperation(context, operation, cancellation.signal);

    context.stdout(`${JSON.stringify(result.result, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('{"ok":false,"code":"check_learning_script_failed","message":"Could not read or process the bounded JSON request"}\n');
    process.exitCode = 1;
  } finally {
    cancellation.close();
    context.close();
  }
}
