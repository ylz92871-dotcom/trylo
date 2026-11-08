import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { VerifiedCentralSkillCreation } from "./central-provenance.js";

export type HermesNativeContextInput = {
  readonly availableTools?: readonly string[];
  readonly availableToolsets?: readonly string[];
  /** Ask the native renderer to retain all names before the host's final hard cap. */
  readonly maxPromptChars?: number;
};

export type HermesNativeContextResult = {
  readonly ok: true; readonly prompt: string;
  /** Native renderer output before the host-specific budget footer adaptation. */
  readonly upstreamPromptHash: string;
} | { readonly ok: false; readonly code: string };

export type HermesUsageResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

type Spawn = (command: string, args: readonly string[], options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio: ["pipe", "pipe", "pipe"]; readonly windowsHide: true;
}) => ChildProcessWithoutNullStreams;

const FAILURE = "hermes_native_context_unavailable";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FAILURE_CODES = new Set(["cancelled", FAILURE, "hermes_version_unavailable", "hermes_context_invalid", "hermes_usage_invalid",
  "hermes_usage_not_recorded", "hermes_context_unknown_operation", "hermes_native_context_timeout", "hermes_native_context_output_limit"]);

/** Process boundary only; Hermes owns the index and usage files. Construct lazily when enabled. */
export function createHermesNativeContext(options: {
  readonly pythonBinary: string; readonly capabilitiesDir: string; readonly hermesHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly warn: (code: string) => void;
  readonly spawn?: Spawn; readonly scriptPath?: string; readonly timeoutMs?: number;
}) {
  const spawnFn = options.spawn ?? spawn;
  const script = options.scriptPath ?? fileURLToPath(new URL("./native-context.py", import.meta.url));

  const call = (request: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> => new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ success: false, code: "cancelled" });
      return;
    }

    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawnFn(options.pythonBinary, [script, "--capabilities-dir", options.capabilitiesDir], {
        env: { ...options.env, HERMES_HOME: options.hermesHome, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      resolve({ success: false, code: FAILURE });
      return;
    }

    let settled = false, output = "", outputBytes = 0;
    const finish = (value: unknown, kill = false) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);

      if (kill) {
        try { child.kill(); }
        catch { /* Cleanup is best-effort after the request has reached its terminal result. */ }
      }

      resolve(value);
    };
    const abort = () => finish({ success: false, code: "cancelled" }, true);
    const timer = setTimeout(() => finish({ success: false, code: "hermes_native_context_timeout" }, true), options.timeoutMs ?? 10_000);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish({ success: false, code: "hermes_native_context_output_limit" }, true);
        return;
      }
      output += chunk;
    });
    child.stderr.on("data", () => { /* Drain dependency diagnostics without copying paths, content or credentials. */ });
    child.on("error", () => finish({ success: false, code: FAILURE }, true));
    child.stdin.on("error", () => finish({ success: false, code: FAILURE }, true));
    child.on("close", code => {
      if (settled) return;
      let value: unknown;
      try { value = JSON.parse(output); }
      catch {
        finish({ success: false, code: FAILURE });
        return;
      }
      finish(code === 0 || record(value) && value.success === false ? value : { success: false, code: FAILURE });
    });

    if (signal?.aborted) {
      abort();
      return;
    }

    try { child.stdin.end(JSON.stringify(request)); }
    catch { finish({ success: false, code: FAILURE }, true); }
  });
  const failure = (value: unknown) => {
    const candidate = record(value) && typeof value.code === "string" ? value.code : FAILURE;
    const code = FAILURE_CODES.has(candidate) ? candidate : FAILURE;
    if (code !== "cancelled") options.warn(code);
    return { ok: false as const, code };
  };

  return {
    /** Internal maintenance capability, never part of the mounted MCP profile. */
    centralOrigin(proof: VerifiedCentralSkillCreation, mode: "inspect" | "repair", previous?: unknown): Promise<unknown> {
      return call({ op: "central_origin", mode, proof: proof.native, ...(previous === undefined ? {} : { previous }) });
    },
    async context(input: HermesNativeContextInput = {}, signal?: AbortSignal): Promise<HermesNativeContextResult> {
      const result = await call({ op: "context", ...input }, signal);
      if (!record(result) || result.success !== true || typeof result.prompt !== "string"
        || typeof result.upstreamPromptHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(result.upstreamPromptHash)) return failure(result);
      return { ok: true, prompt: result.prompt, upstreamPromptHash: result.upstreamPromptHash };
    },
    async recordView(input: { readonly name: string }, signal?: AbortSignal): Promise<HermesUsageResult> {
      const result = await call({ op: "record_view", name: input.name }, signal);
      return record(result) && result.success === true ? { ok: true } : failure(result);
    },
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
