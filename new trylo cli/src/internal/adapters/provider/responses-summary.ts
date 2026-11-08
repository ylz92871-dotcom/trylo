import type { ProviderEvent } from "../../ports/provider.js";

type SummaryBlock = { readonly parts: Map<number, string> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function index(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** One owner for public summary delivery across deltas and overlapping snapshots.
 *  Only summary_text is read. Encrypted content and raw reasoning are unrelated
 *  wire fields and must never become a substitute summary. */
export function createResponsesSummary() {
  const blocks = new Map<number, SummaryBlock>();
  const sealed = new Set<number>();

  function append(output: number, part: number, text: string): ProviderEvent[] {
    if (!text || sealed.has(output)) return [];

    const events: ProviderEvent[] = [];
    let block = blocks.get(output);
    const blockId = `reasoning-${output}`;

    if (!block) {
      block = { parts: new Map() };
      blocks.set(output, block);
      events.push({ type: "reasoning_start", blockId, redacted: false });
    }

    const separator = !block.parts.has(part) && block.parts.size > 0 ? "\n\n" : "";

    block.parts.set(part, (block.parts.get(part) ?? "") + text);
    events.push({ type: "reasoning_delta", blockId, text: separator + text, redacted: false });

    return events;
  }

  function snapshot(output: number, part: number, value: unknown): ProviderEvent[] {
    if (typeof value !== "string" || sealed.has(output)) return [];
    const delivered = blocks.get(output)?.parts.get(part) ?? "";
    // A stale/changed snapshot cannot retract bytes already streamed. Only a
    // compatible extension can add facts without duplicating or rewriting them.
    return value.startsWith(delivered) ? append(output, part, value.slice(delivered.length)) : [];
  }

  function close(output: number): ProviderEvent[] {
    if (!blocks.delete(output)) return [];
    sealed.add(output);
    return [{ type: "reasoning_end", blockId: `reasoning-${output}` }];
  }

  function itemDone(output: number, item: Record<string, unknown>): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    const summary = item["summary"];
    if (Array.isArray(summary)) summary.forEach((part: unknown, partIndex: number) => {
      if (record(part) && part["type"] === "summary_text") events.push(...snapshot(output, partIndex, part["text"]));
    });
    return [...events, ...close(output)];
  }

  return {
    delta(payload: Record<string, unknown>): ProviderEvent[] {
      const value = payload["delta"];
      return typeof value === "string" ? append(index(payload["output_index"]), index(payload["summary_index"]), value) : [];
    },
    textDone(payload: Record<string, unknown>): ProviderEvent[] {
      return snapshot(index(payload["output_index"]), index(payload["summary_index"]), payload["text"]);
    },
    partDone(payload: Record<string, unknown>): ProviderEvent[] {
      const part = payload["part"];
      return record(part) && part["type"] === "summary_text"
        ? snapshot(index(payload["output_index"]), index(payload["summary_index"]), part["text"]) : [];
    },
    itemDone,
    completed(output: unknown): ProviderEvent[] {
      const events: ProviderEvent[] = [];
      if (Array.isArray(output)) output.forEach((item: unknown, outputIndex: number) => {
        if (record(item) && item["type"] === "reasoning") events.push(...itemDone(outputIndex, item));
      });
      return events;
    },
    closeAll(): ProviderEvent[] {
      return [...blocks.keys()].sort((a, b) => a - b).flatMap(close);
    },
  };
}
