import type { Envelope, JsonObject } from "./envelope.js";

/** Execution observations and authored user reports are deliberately distinct. */
export type SubagentObservation = {
  readonly id: string;
  readonly round: number;
  readonly kind: "text" | "thinking" | "tool" | "result" | "report";
  readonly text?: string;
  readonly tool?: string;
  readonly input?: JsonObject;
  readonly ok?: boolean;
  readonly reportState?: "progress" | "blocked" | "ready";
};

export function isSubagentObservation(value: unknown): value is SubagentObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0 && typeof row.round === "number" && Number.isInteger(row.round) && row.round > 0
    && ["text", "thinking", "tool", "result", "report"].includes(String(row.kind))
    && (row.text === undefined || typeof row.text === "string" && row.text.length <= 24000)
    && (row.tool === undefined || typeof row.tool === "string")
    && (row.input === undefined || row.input !== null && typeof row.input === "object" && !Array.isArray(row.input))
    && (row.ok === undefined || typeof row.ok === "boolean")
    && (row.kind !== "report" || typeof row.text === "string" && ["progress", "blocked", "ready"].includes(String(row.reportState)));
}

/** One worker owns block assembly; consumers receive replay-safe snapshots. */
export function createSubagentObserver(publish: (observation: SubagentObservation) => void): (envelope: Envelope, round: number) => void {
  let block: { kind: "text" | "thinking"; id: string; text: string; round: number } | undefined;
  let part = 0;
  return (envelope, round) => {
    const payload = envelope.payload;
    if (envelope.kind === "text" || envelope.kind === "thinking") {
      if (envelope.kind === "thinking" && payload.redacted === true) { block = undefined; return; }
      if (typeof payload.text !== "string" || !payload.text) return;
      let remaining = payload.text;
      while (remaining) {
        if (!block || block.kind !== envelope.kind || block.round !== round) block = { kind: envelope.kind, id: `${envelope.eventId}:${part++}`, text: "", round };
        let take = Math.min(6000 - block.text.length, remaining.length);
        if (take < remaining.length && /[\uD800-\uDBFF]/.test(remaining[take - 1] ?? "")) take -= 1;
        block.text += remaining.slice(0, take);
        remaining = remaining.slice(take);
        publish({ ...block });
        if (block.text.length >= 5999) block = undefined;
      }
      return;
    }
    if (envelope.kind !== "tool_use" && envelope.kind !== "tool_result") return;
    block = undefined;
    if (typeof payload.toolCallId !== "string" || payload.name === "report_progress") return;
    const tool = typeof payload.name === "string" ? payload.name : undefined;
    if (envelope.kind === "tool_use") {
      const args = payload.arguments;
      const input = args !== null && typeof args === "object" && !Array.isArray(args) && JSON.stringify(args).length <= 12000 ? args as JsonObject : undefined;
      publish({ id: payload.toolCallId, kind: "tool", round, ...(tool === undefined ? {} : { tool }), ...(input === undefined ? {} : { input }) });
    } else {
      const text = payload.status === "succeeded" ? payload.output : payload.message;
      publish({ id: payload.toolCallId, kind: "result", round, ok: payload.status === "succeeded",
        ...(tool === undefined ? {} : { tool }), ...(typeof text === "string" ? { text: text.length > 6000 ? `${text.slice(0, 5940)}\n…（输出过长，完整记录保留在原始会话中）` : text } : {}) });
    }
  };
}
