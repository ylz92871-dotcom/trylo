import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IsolationPort, IsolationOutcome } from "../../ports/isolation.js";
import type { CandidateExecution, CandidateExecutor } from "../../learning/domains/tool/evolution/execution.js";
import { isJsonValue, jsonBytes, recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { TOOL_EVOLUTION_MAX_SAMPLE_BYTES } from "../../learning/domains/tool/evolution/contracts.js";
import { RUNNER, readResult } from "./process-protocol.js";
import { checkJsonFunctionSource } from "./json-function-policy.js";

export type ProcessToolExecutorOptions = {
  readonly isolation: IsolationPort;
  readonly scratchRoot: string;
  readonly nodeExecutable: string;
  readonly timeoutMs?: number;
  readonly profile?: "confined_json_function_v1";
};

/** A new confined process and private input directory for every invocation. */
export function createToolCandidateExecutor(options: ProcessToolExecutorOptions): CandidateExecutor {
  if (!path.isAbsolute(options.scratchRoot) || !path.isAbsolute(options.nodeExecutable)) throw new Error("tool execution requires absolute scratch and executable paths");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60_000)) throw new Error("tool execution timeout must be an integer in 1..60000 ms");
  return {
    async execute(candidate, input, signal): Promise<CandidateExecution> {
      if (signal.aborted) return { kind: "cancelled" };
      if (!isJsonValue(input) || jsonBytes(input) > TOOL_EVOLUTION_MAX_SAMPLE_BYTES) return { kind: "protocol_error", detail: "input exceeds bounded JSON contract" };
      const admitted = options.profile === "confined_json_function_v1" ? checkJsonFunctionSource(candidate.source) : { ok: true as const, program: candidate.source };
      if (!admitted.ok) return { kind: "protocol_error", detail: admitted.code };
      try {
        const ready = await options.isolation.probe();
        if (signal.aborted) return { kind: "cancelled" };
        if (ready.state !== "ready") return { kind: "unavailable", detail: "required OS isolation is unavailable" };
        await mkdir(options.scratchRoot, { recursive: true });
        const directory = await mkdtemp(path.join(options.scratchRoot, "candidate-"));
        await writeFile(path.join(directory, "candidate.cjs"), admitted.program, { encoding: "utf8", flag: "wx" });
        const runner = path.join(directory, "runner.cjs");
        await writeFile(runner, RUNNER, { encoding: "utf8", flag: "wx" });
        const result = await options.isolation.run({
          argv: [options.nodeExecutable, "--permission", `--allow-fs-read=${directory}`, "--disable-proto=throw",
            ...(options.profile === "confined_json_function_v1" ? ["--disallow-code-generation-from-strings"] : []),
            "--preserve-symlinks", "--preserve-symlinks-main", runner, Buffer.from(JSON.stringify(input), "utf8").toString("base64")],
          cwd: directory, files: { writableRoots: [directory], denyReadPaths: [], denyWritePaths: [] },
          network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: true }, env: {}, timeoutMs: options.timeoutMs ?? 5_000, signal,
        });
        return classify(result, signal);
      } catch {
        return signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", detail: "isolated execution setup failed" };
      }
    },
  };
}

function classify(result: IsolationOutcome, signal: AbortSignal): CandidateExecution {
  if (result.outcome === "cancelled" || signal.aborted) return { kind: "cancelled" };
  if (result.outcome === "isolation_failed" || result.cleanupFailure !== undefined) return { kind: "unavailable", detail: "isolation start or cleanup failed" };
  if (result.timedOut) return { kind: "timeout", detail: "execution exceeded its deadline" };
  if (result.exitCode !== 0 || result.stdout.length > 65_536 || result.stderr.length > 65_536) return { kind: "protocol_error", detail: "process exit or capture limit failure" };
  const output = readResult(result.stdout);
  if (recordOf(output) && output.kind === "value" && isJsonValue(output.value)) return { kind: "value", value: output.value };
  if (recordOf(output) && output.kind === "error" && typeof output.code === "string") return { kind: "tool_error", code: output.code };
  return { kind: "protocol_error", detail: "process returned no bounded JSON result" };
}
