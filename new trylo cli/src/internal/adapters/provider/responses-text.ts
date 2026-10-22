import type { ProviderEvent } from "../../ports/provider.js";
import { isResponseRecord as record, responseNumber as num } from "./responses-fields.js";
import { responsesProtocolError } from "./responses-error.js";

type Block = { readonly parts: Map<number, string> };

/** Public text deltas and snapshots share a prefix. Final snapshots may fill a
 * missing suffix, but never retract streamed text or reopen a sealed item.
 */
export function createResponsesText() {
  const open = new Map<number, Block>(), sealed = new Map<number, Block>();
  function append(output: number, part: number, text: string): ProviderEvent[] {
    if (!text || sealed.has(output)) return [];
    const events: ProviderEvent[] = [], blockId = `text-${output}`;
    let block = open.get(output);
    if (block === undefined) {
      block = { parts: new Map() }; open.set(output, block);
      events.push({ type: "text_start", blockId });
    }
    const separator = !block.parts.has(part) && block.parts.size > 0 ? "\n\n" : "";
    block.parts.set(part, (block.parts.get(part) ?? "") + text);
    events.push({ type: "text_delta", blockId, text: separator + text });
    return events;
  }
  function snapshot(output: number, part: number, value: unknown): ProviderEvent[] {
    if (typeof value !== "string") return [];
    const delivered = (open.get(output) ?? sealed.get(output))?.parts.get(part) ?? "";
    if (!value.startsWith(delivered) || (sealed.has(output) && value !== delivered)) {
      return [responsesProtocolError("responses_text_snapshot_conflict")];
    }
    return append(output, part, value.slice(delivered.length));
  }
  function close(output: number): ProviderEvent[] {
    const block = open.get(output);
    if (block === undefined) return [];
    open.delete(output);
    sealed.set(output, block);
    return [{ type: "text_end", blockId: `text-${output}` }];
  }
  return {
    delta(payload: Record<string, unknown>): ProviderEvent[] {
      const delta = payload["delta"];
      return typeof delta === "string" ? append(num(payload, "output_index"), num(payload, "content_index"), delta) : [];
    },
    done(payload: Record<string, unknown>): ProviderEvent[] {
      return snapshot(num(payload, "output_index"), num(payload, "content_index"), payload["text"]);
    },
    itemDone(output: number, item: Record<string, unknown>): ProviderEvent[] {
      const events: ProviderEvent[] = [], content = item["content"];
      if (Array.isArray(content)) content.forEach((part: unknown, index: number) => {
        if (record(part) && part["type"] === "output_text") events.push(...snapshot(output, index, part["text"]));
      });
      return [...events, ...close(output)];
    },
    closeAll: (): ProviderEvent[] => [...open.keys()].sort((a, b) => a - b).flatMap(close),
  };
}
