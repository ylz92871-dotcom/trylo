import type { ProviderEvent } from "../../ports/provider.js";

type Finish = Extract<ProviderEvent, { type: "finish" }>;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function recognizedChunk(payload: unknown): payload is Record<string, unknown> {
  if (!object(payload)) return false;

  if (payload.choices === undefined) return object(payload.usage);

  if (!Array.isArray(payload.choices)) return false;

  if (payload.choices.length === 0) return true;

  if (payload.choices.length !== 1 || !object(payload.choices[0])) return false;

  const choice = payload.choices[0];

  return (choice.delta === undefined || choice.delta === null || object(choice.delta))
    && (choice.finish_reason === undefined || choice.finish_reason === null || typeof choice.finish_reason === "string");
}

/** Observes only frames the ordinary decoder already received. Never pulls or waits. */
export function createOpenAiReturnObservation() {
  let reportedTotalTokens: number | undefined;
  let invalid = false;
  let finished = false;

  return {
    frame(payload: unknown, events: readonly ProviderEvent[]): void {
      if (!recognizedChunk(payload)) invalid = true;

      if (object(payload) && payload.usage !== undefined && payload.usage !== null) {
        if (!object(payload.usage) || !count(payload.usage.total_tokens)) invalid = true;
        else reportedTotalTokens = payload.usage.total_tokens;
      }

      for (const event of events) {
        if (finished && event.type !== "usage") invalid = true;
        if (event.type === "finish") finished = true;
        if (event.type === "raw_unknown" || event.type === "error" || event.type === "cancel_ack"
          || event.type === "tool_call_invalid") invalid = true;
      }
    },
    finish(event: Finish, cleanEnd: boolean): Finish {
      return !cleanEnd || invalid || reportedTotalTokens === undefined
        || (event.reason !== "stop" && event.reason !== "tool_calls") ? event
        : { ...event, returnObservation: { schemaVersion: 1, reportedTotalTokens } };
    },
  };
}
