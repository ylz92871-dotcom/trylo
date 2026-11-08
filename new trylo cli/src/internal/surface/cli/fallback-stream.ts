import { isCliRunResult, type CliRunResult } from "../../protocol/cli-stream.js";
import type { CliSink } from "./render.js";

/** One external JSONL run may contain two durable model attempts. */
export function createFallbackStream(target: CliSink): { readonly sink: CliSink; readonly finish: () => void } {
  let phase: "open" | "closed" = "open";
  let first: { readonly sessionId: string; readonly turnId: string; readonly model: string } | undefined;
  let previous: CliRunResult | undefined;
  let pending: CliRunResult | undefined;

  return {
    sink: {
      stderr: target.stderr,

      stdout(line) {
        if (phase === "closed") return;

        let raw: unknown;

        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          // Preserve unexpected producer output for the host's wire guard.
          target.stdout(line);
          return;
        }

        if (isCliRunResult(raw)) {
          pending = raw;
          return;
        }

        if (isRecord(raw) && raw.type === "run_start" && typeof raw.sessionId === "string" &&
            typeof raw.turnId === "string" && typeof raw.model === "string") {
          if (first === undefined) {
            first = { sessionId: raw.sessionId, turnId: raw.turnId, model: raw.model };
          } else {
            previous = pending;
            pending = undefined;
            target.stdout(`${JSON.stringify({ type: "warning", code: "model_fallback",
              message: `Primary model ${first.model} failed transiently; retrying once on ${raw.model}.` })}\n`);
            return;
          }
        }

        target.stdout(line);
      },
    },

    finish() {
      if (phase === "closed") return;

      phase = "closed";
      const result = pending ?? previous;
      if (result === undefined || first === undefined) return;

      const earlier = pending === undefined ? undefined : previous;

      target.stdout(`${JSON.stringify({
        ...result,
        sessionId: first.sessionId,
        turnId: first.turnId,
        ...(result.turnId === first.turnId ? {} : { attemptTurnId: result.turnId }),
        iterations: result.iterations + (earlier?.iterations ?? 0),
        durationMs: result.durationMs + (earlier?.durationMs ?? 0),
        usage: {
          inputTokens: result.usage.inputTokens + (earlier?.usage.inputTokens ?? 0),
          outputTokens: result.usage.outputTokens + (earlier?.usage.outputTokens ?? 0),
          totalTokens: result.usage.totalTokens + (earlier?.usage.totalTokens ?? 0),
        },
      })}\n`);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
