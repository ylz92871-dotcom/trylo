import { spawn, type ChildProcess } from "node:child_process";
import type { CommandShape } from "../../sandbox/executable.js";

/** Mechanical argv spawning, shared by host pipes and the restricted Windows runner. */
export function startShellChild(shape: CommandShape, cwd: string, stdio: readonly ["ignore" | "pipe", "pipe", "pipe"], env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): ChildProcess {
  const [file, ...args] = shape.argv;
  if (file === undefined) throw new Error("shell needs an executable");
  return spawn(file, args, {
    cwd, env, stdio: [...stdio], windowsHide: true,
    ...(platform === "win32" ? {} : { detached: true }),
    ...(shape.kind === "shell" ? { windowsVerbatimArguments: true } : {}),
  });
}

/** One spawn per admitted stage, with literal stdout/stdin pipes and no shell parsing. */
export function startShellPipeline(shapes: readonly CommandShape[], start: (shape: CommandShape, receiver: boolean) => ChildProcess): readonly ChildProcess[] {
  // Node throws synchronously on NUL/empty argv. Validate every stage before
  // launching any producer, which would otherwise outlive a rejected receiver.
  for (const shape of shapes) {
    if (shape.argv.length === 0 || shape.argv[0] === "" || shape.argv.some(arg => arg.includes("\0"))) {
      throw new Error("invalid_pipeline_argv");
    }
  }
  const children = shapes.map((shape, index) => start(shape, index > 0));
  for (let index = 0; index + 1 < children.length; index += 1) {
    const producer = children[index]?.stdout;
    const receiver = children[index + 1];
    const input = receiver?.stdin;
    if (producer === null || producer === undefined || receiver === undefined || input === null || input === undefined) continue;
    input.on("close", () => {
      // A finite producer must be able to finish after a receiver such as head
      // exits early. The discarded tail is not the final stage's stdout.
      producer.unpipe(input);
      producer.resume();
    });
    input.on("error", (error: NodeJS.ErrnoException) => {
      // A receiver may deliberately finish before consuming all producer bytes.
      if (error.code !== "EPIPE") receiver.emit("error", error);
    });
    producer.pipe(input);
  }
  return children;
}
