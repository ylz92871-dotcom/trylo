import { Worker } from "node:worker_threads";

export type RegexHit = { readonly line: number; readonly index: number };
type Reply = { readonly kind: "ready" } | { readonly kind: "matches"; readonly hits: ReadonlyArray<RegexHit> };
export class RegexSearchError extends Error {
  constructor(readonly code: "invalid_pattern" | "regex_timeout" | "regex_worker_failed", message: string) { super(message); }
}

function readReply(value: unknown): Reply {
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("invalid_regex_reply");
  if (value.kind === "invalid_pattern" && "message" in value && typeof value.message === "string") {
    throw new RegexSearchError("invalid_pattern", value.message);
  }
  if (value.kind === "ready") return { kind: "ready" };
  if (value.kind !== "matches" || !("hits" in value) || !Array.isArray(value.hits)) throw new Error("invalid_regex_reply");
  const hits: RegexHit[] = [];
  for (const hit of value.hits) {
    if (typeof hit !== "object" || hit === null || !("line" in hit) || !("index" in hit) ||
        !Number.isSafeInteger(hit.line) || !Number.isSafeInteger(hit.index) || hit.line < 0 || hit.index < 0) {
      throw new Error("invalid_regex_hit");
    }
    hits.push({ line: hit.line, index: hit.index });
  }
  return { kind: "matches", hits };
}

/** One worker per search, reused for each bounded file; only it executes user regexes. */
export class RegexSearch {
  private readonly worker: Worker;
  private terminated: Promise<number> | undefined;
  private failure: RegexSearchError | undefined;

  constructor(pattern: string, ignoreCase: boolean, private readonly signal: AbortSignal) {
    signal.throwIfAborted();
    this.worker = new Worker(new URL("./regex-worker.js", import.meta.url), {
      workerData: { pattern, ignoreCase },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
      // A CLI started with --input-type or a test loader must not leak that mode into a file worker.
      execArgv: [],
    });
    // Keep a lifetime error owner even between the startup and per-file waits.
    this.worker.on("error", error => { this.failure = new RegexSearchError("regex_worker_failed", error.message); });
    this.worker.on("exit", code => { this.failure ??= new RegexSearchError("regex_worker_failed", `regex_worker_exited:${code}`); });
  }

  async ready(): Promise<void> {
    const reply = await this.receive(2_000);
    if (reply.kind !== "ready") throw new RegexSearchError("regex_worker_failed", "unexpected_regex_startup_reply");
  }

  async scan(text: string, limit: number): Promise<ReadonlyArray<RegexHit>> {
    const pending = this.receive(250);
    this.worker.postMessage({ text, limit });
    const reply = await pending;
    if (reply.kind !== "matches") throw new RegexSearchError("regex_worker_failed", "unexpected_regex_scan_reply");
    return reply.hits;
  }

  close(): Promise<number> {
    this.terminated ??= this.worker.terminate();
    return this.terminated;
  }

  private receive(timeoutMs: number): Promise<Reply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", aborted);
        this.worker.off("message", message);
        this.worker.off("error", failed);
        this.worker.off("exit", exited);
      };
      const stop = (error: Error): void => { cleanup(); reject(error); };
      const aborted = (): void => stop(new Error("aborted"));
      const failed = (error: Error): void => stop(new RegexSearchError("regex_worker_failed", error.message));
      const exited = (code: number): void => stop(new RegexSearchError("regex_worker_failed", `regex_worker_exited:${code}`));
      const message = (value: unknown): void => {
        cleanup();
        try { resolve(readReply(value)); } catch (error) { reject(error); }
      };
      const timer = setTimeout(() => stop(new RegexSearchError("regex_timeout",
        "Regex exceeded its execution budget; narrow the file scope, simplify the pattern, or use literal mode.")), timeoutMs);
      this.worker.once("message", message);
      this.worker.once("error", failed);
      this.worker.once("exit", exited);
      this.signal.addEventListener("abort", aborted, { once: true });
      if (this.signal.aborted) aborted();
    });
  }
}
