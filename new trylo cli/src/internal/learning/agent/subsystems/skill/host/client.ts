import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HermesSkillOpportunity } from "../contracts.js";
import { withHermesViewTransportBudget } from "./view-transport.js";

export type HermesToolProfile = {
  readonly name: string; readonly command: string; readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>; readonly allowedTools: readonly string[];
};

export type HermesShadowRequest = { readonly prompt: string; readonly profile: HermesToolProfile };

type ShadowRunner = (request: HermesShadowRequest, signal: AbortSignal) => Promise<{ readonly answer: string }>;

type RequestOptions = { readonly signal?: AbortSignal; readonly runShadow?: ShadowRunner; readonly timeoutMs?: number };

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void;
  readonly worker: ChildProcessWithoutNullStreams; readonly controller: AbortController;
  readonly options: RequestOptions; readonly cleanup: () => void };

/** A runtime-owned worker preserves Hermes' process-local orchestration and native files. */
export function createHermesNodeClient(options: {
  readonly nodeBinary: string; readonly env: Readonly<Record<string, string | undefined>>;
  readonly storageRoot: string; readonly nextId: () => string; readonly workerPath?: string;
}) {
  const workerPath = options.workerPath ?? fileURLToPath(new URL("./worker.mjs", import.meta.url));
  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<string, Pending>();
  const finish = (id: string, job: Pending, value: unknown, error?: Error) => {
    if (pending.get(id) !== job) return;
    pending.delete(id);
    job.cleanup();
    if (error) {
      job.controller.abort();
      job.reject(error);
    } else job.resolve(value);
  };
  const stop = (code: string) => {
    const previous = child;
    child = undefined;
    previous?.kill();
    for (const [id, job] of [...pending]) finish(id, job, undefined, new Error(code));
  };
  const send = (worker: ChildProcessWithoutNullStreams, value: unknown) => {
    if (child !== worker || worker.stdin.destroyed) throw new Error("hermes_worker_closed");
    worker.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const current = (id: string, job: Pending) => child === job.worker && pending.get(id) === job;
  const consume = async (frame: Record<string, unknown>, worker: ChildProcessWithoutNullStreams) => {
    if (child !== worker) return;

    if (typeof frame.id !== "string") return;

    const job = pending.get(frame.id);
    if (!job || job.worker !== worker) return;

    if (frame.type === "result") {
      finish(frame.id, job, frame.result);
      return;
    }

    if (frame.type === "error") {
      finish(frame.id, job, undefined, new Error(typeof frame.error === "string" ? frame.error : "hermes_worker_failed"));
      return;
    }

    if (frame.type !== "shadow" || typeof frame.shadowId !== "string") return;

    try {
      if (!job.options.runShadow || typeof frame.prompt !== "string" || !isHermesToolProfile(frame.profile)) throw new Error("hermes_shadow_unavailable");
      const result = await job.options.runShadow({ prompt: frame.prompt, profile: withHermesViewTransportBudget(frame.profile) }, job.controller.signal);
      if (current(frame.id, job)) send(worker, { type: "shadow_result", shadowId: frame.shadowId, answer: result.answer });
    } catch (error) {
      if (current(frame.id, job)) send(worker, { type: "shadow_error", shadowId: frame.shadowId,
        error: error instanceof Error ? error.message : "hermes_shadow_failed" });
    }
  };
  const ensure = () => {
    if (child) return child;

    const started = spawn(options.nodeBinary, [workerPath], { env: { ...options.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";

    child = started;
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      if (child !== started) return;

      buffer += chunk;

      if (buffer.length > 1_048_576) {
        stop("hermes_worker_output_limit");
        return;
      }

      let newline;

      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { continue; /* Existing dependency chatter is not a protocol frame. */ }
        if (record(frame)) void consume(frame, started).catch(() => {
          if (child === started) stop("hermes_worker_protocol_failed");
        });
      }
    });
    started.stderr.on("data", () => { /* Native failures return in the owned JSON reply; never print raw prompts or credentials. */ });
    started.stdin.on("error", () => { if (child === started) stop("hermes_worker_pipe_failed"); });
    started.on("error", () => { if (child === started) stop("hermes_worker_start_failed"); });
    started.on("close", () => { if (child === started) stop("hermes_worker_closed"); });

    return started;
  };
  const request = (operation: string, payload: Record<string, unknown>, input: RequestOptions = {}) => new Promise<unknown>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }

    const id = options.nextId(), controller = new AbortController();
    if (pending.has(id)) {
      reject(new Error("duplicate_request_id"));
      return;
    }

    try {
      const worker = ensure();
      const cancel = (reason: "cancelled" | "timeout") => {
        if (!current(id, job)) return;

        // Native compatibility mutations may already have committed. Cancelling
        // the transport does not claim to undo them or cancel unrelated work.
        const code = operation === "compat" ? `hermes_compat_${reason}_unknown`
          : reason === "cancelled" ? "cancelled" : "hermes_worker_timeout";

        finish(id, job, undefined, new Error(code));

        try { send(worker, { type: "cancel", id }); }
        catch { if (child === worker) stop("hermes_worker_pipe_failed"); }
      };
      const abort = () => cancel("cancelled");
      const timer = setTimeout(() => cancel("timeout"), input.timeoutMs ?? (operation === "learn" ? 180_000 : 30_000));
      const job: Pending = { resolve, reject, worker, controller, options: input,
        cleanup: () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
        } };

      pending.set(id, job);
      input.signal?.addEventListener("abort", abort, { once: true });

      if (input.signal?.aborted) {
        abort();
        return;
      }

      try { send(worker, { type: "request", id, operation, storageRoot: options.storageRoot, ...payload }); }
      catch (error) { finish(id, job, undefined, error instanceof Error ? error : new Error("hermes_worker_start_failed")); }
    } catch (error) { reject(error instanceof Error ? error : new Error("hermes_worker_start_failed")); }
  });

  return {
    learn: (opportunity: HermesSkillOpportunity, input: RequestOptions) => request("learn", { opportunity }, input),
    review: (action: "seen" | "begin" | "finish" | "release", payload: Record<string, unknown>, signal?: AbortSignal) =>
      request("review", { action, ...payload }, signal === undefined ? {} : { signal }),
    compatibility: (method: string, params: Readonly<Record<string, unknown>> = {}, input?: RequestOptions) => request("compat", { method, params }, input),
    async profile(profile: "normal" | "learning", signal?: AbortSignal, reviewMode: "implicit" | "explicit" = "implicit",
      reviewOrigin: "native" | "central_research" = "native"): Promise<HermesToolProfile> {
      const result = await request("profile", { profile, reviewMode, reviewOrigin }, signal === undefined ? {} : { signal });
      if (!isHermesToolProfile(result)) throw new Error("hermes_profile_invalid");
      return withHermesViewTransportBudget(result);
    },
    close: () => stop("hermes_worker_closed"),
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }

function isHermesToolProfile(value: unknown): value is HermesToolProfile {
  return record(value) && typeof value.name === "string" && typeof value.command === "string" && strings(value.args)
    && strings(value.allowedTools) && record(value.env) && Object.values(value.env).every(item => typeof item === "string");
}
