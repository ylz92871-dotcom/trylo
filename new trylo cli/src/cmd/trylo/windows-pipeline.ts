import type { CommandShape } from "../../internal/adapters/sandbox/executable.js";
import { startShellChild, startShellPipeline } from "../../internal/adapters/tools/mutating/shell-child-processes.js";

/** Private process entry: executes only already-admitted argv inside the SRT Job. */
function readStages(text: string | undefined): readonly CommandShape[] {
  const value: unknown = JSON.parse(text ?? "null");
  if (!Array.isArray(value) || value.length < 1 || !value.every(stage => stage !== null && typeof stage === "object" && (stage.kind === "direct" || stage.kind === "shell") && Array.isArray(stage.argv) && typeof stage.argv[0] === "string" && stage.argv[0].length > 0 && stage.argv.every((word: unknown) => typeof word === "string" && !word.includes("\0")))) {
    throw new Error("isolation_pipeline_invalid: expected admitted command stages");
  }
  return value;
}

function failPipeline(error: unknown): void {
  // Closing the restricted runner closes its existing SRT Job and all children.
  process.stderr.write(`isolation_pipeline_failed: ${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
}

try {
  const children = startShellPipeline(readStages(process.argv[2]), (shape, receiver) => startShellChild(shape, process.cwd(), [receiver ? "pipe" : "ignore", "pipe", "pipe"], process.env, "win32"));
  const last = children.at(-1);
  last?.stdout?.pipe(process.stdout, { end: false });
  let closed = 0;
  for (const child of children) {
    child.stderr?.pipe(process.stderr, { end: false });
    child.on("error", failPipeline);
    child.on("close", () => {
      closed += 1;
      if (closed === children.length) process.exitCode = last?.exitCode ?? 1;
    });
  }
} catch (error) {
  failPipeline(error);
}
