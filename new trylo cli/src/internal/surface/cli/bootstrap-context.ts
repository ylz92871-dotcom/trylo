import { Buffer } from "node:buffer";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { Transcript } from "../../protocol/transcript.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { RunFailure } from "./run-failure.js";

/** Text-only prior context, never current consent or native provider state. */
export type BootstrapContext = {
  readonly version: 1;
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
};

/** Import pending until turn_start commits; ephemeral fallback retains read-only context. */
export type BootstrapContextBinding = {
  readonly state: "import_pending" | "established_read_only";
  readonly context: BootstrapContext;
};

export class BootstrapContextError extends Error {
  constructor(readonly source: "input" | "journal", readonly code: string) { super(code); }
}

export function bootstrapContextFailure(error: BootstrapContextError): RunFailure {
  return { exitCode: EXIT_CODES.CONFIG,
    message: `${error.source === "journal" ? "bootstrap_context_journal_invalid" : "bootstrap_context_input_invalid"}:${error.code}`,
    hint: error.source === "journal" ? "inspect the session journal bootstrap metadata before resuming; provider execution was stopped"
      : "send initial prior context only before a CLI transcript exists; provider execution was stopped" };
}

export const BOOTSTRAP_CONTEXT_LIMITS = { messages: 128, messageBytes: 262144, totalBytes: 1048576 } as const;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Validate both transport and journal metadata through the same boundary. */
export function parseBootstrapContext(value: unknown, source: "input" | "journal" = "input"): BootstrapContext {
  if (!plainRecord(value) || !Object.hasOwn(value, "version") || value.version !== 1
    || !Object.hasOwn(value, "messages") || !Array.isArray(value.messages)
    || value.messages.length === 0 || value.messages.length > BOOTSTRAP_CONTEXT_LIMITS.messages) {
    throw new BootstrapContextError(source, "invalid_bootstrap_context");
  }

  let total = 0;
  const messages: BootstrapContext["messages"][number][] = [];

  for (const message of value.messages) {
    if (!plainRecord(message) || !Object.hasOwn(message, "role") || (message.role !== "user" && message.role !== "assistant")
      || !Object.hasOwn(message, "content") || typeof message.content !== "string" || message.content.trim().length === 0
      || Object.keys(message).some(key => key !== "role" && key !== "content")) throw new BootstrapContextError(source, "invalid_bootstrap_context");

    const bytes = Buffer.byteLength(message.content, "utf8");

    total += bytes;

    if (bytes > BOOTSTRAP_CONTEXT_LIMITS.messageBytes || total > BOOTSTRAP_CONTEXT_LIMITS.totalBytes) throw new BootstrapContextError(source, "bootstrap_context_limit_exceeded");

    messages.push({ role: message.role, content: message.content });
  }

  if (Object.keys(value).some(key => key !== "version" && key !== "messages")) throw new BootstrapContextError(source, "invalid_bootstrap_context");

  return { version: 1, messages };
}

/** One initial import per CLI session; journal provenance remains separate from transcript. */
type BootstrapInput = {
  readonly bootstrap?: BootstrapContextBinding;
  readonly session?: SessionPort;
  readonly resumeRecords?: ReadonlyArray<SessionRecord>;
  readonly resumeTranscript?: Transcript;
};

export function bootstrapContextFor(input: BootstrapInput): BootstrapContext | undefined {
  let context: BootstrapContext | undefined;

  for (const record of input.resumeRecords ?? []) {
    if (record.type !== "turn_start" || !("bootstrapContext" in record.payload)) continue;
    if (context !== undefined) throw new BootstrapContextError("journal", "duplicate_bootstrap_context");
    context = parseBootstrapContext(record.payload["bootstrapContext"], "journal");
  }

  if (input.bootstrap === undefined) return context;

  if (!plainRecord(input.bootstrap) || !Object.hasOwn(input.bootstrap, "state") || !Object.hasOwn(input.bootstrap, "context")
    || Object.keys(input.bootstrap).some(key => key !== "state" && key !== "context")
    || (input.bootstrap.state !== "import_pending" && input.bootstrap.state !== "established_read_only")
    || (input.bootstrap.state === "established_read_only" && input.session !== undefined)) throw new BootstrapContextError("input", "invalid_bootstrap_context_state");

  if (context !== undefined || (input.bootstrap.state === "import_pending" && ((input.resumeTranscript?.length ?? 0) > 0
    || (input.resumeRecords ?? []).some(record => record.type === "transcript_item")))) throw new BootstrapContextError("input", "bootstrap_context_requires_new_history");

  return parseBootstrapContext(input.bootstrap.context);
}

/** A retry restores durable metadata, or retains ephemeral context without importing it again. */
export async function bootstrapForFallback(input: BootstrapInput): Promise<{
  readonly bootstrap?: BootstrapContextBinding; readonly resumeRecords?: ReadonlyArray<SessionRecord>;
}> {
  const context = bootstrapContextFor(input);
  if (context === undefined) return {};

  if (input.session === undefined) return { bootstrap: { state: "established_read_only", context } };

  const read = await input.session.readRecords();
  if (!read.ok) throw new BootstrapContextError("journal", "bootstrap_context_read_failed");

  const restored = bootstrapContextFor({ resumeRecords: read.view.records });
  if (restored === undefined || JSON.stringify(restored) !== JSON.stringify(context)) throw new BootstrapContextError("journal", "bootstrap_context_missing_or_changed");

  return { resumeRecords: read.view.records };
}
