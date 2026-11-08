import { MAX_TOOL_OUTPUT_BYTES } from "../../loop/tool-execution.js";
import { MAX_PAYLOAD_BYTES } from "../../protocol/envelope.js";
import { cutToBytes } from "../../protocol/text-cut.js";
import { contentHashOf } from "../../learning/control/hash.js";

// A caller may request at most this many source bytes. The actual page can be
// smaller: the journal records both structured value and escaped output text.
export const CENTRAL_RESPONSE_PAGE_BYTES = Math.floor((MAX_TOOL_OUTPUT_BYTES - 4096) / 2);
const CAPACITY = 4 * 1024 * 1024;

type ResponsePage = { readonly status: "response_page"; readonly responseRef: string; readonly sourceHash: string;
  readonly unit: "utf8_bytes"; readonly start: number; readonly end: number; readonly totalBytes: number;
  readonly nextStart: number | null; readonly text: string };

/** Wire cache only. Original Board/stages remain authoritative; this stores no
 * funds, claims or retry rights and dies with its original turn's tool port. */
export function createCentralLearningResponses() {
  const saved = new Map<string, { readonly output: string; readonly bytes: Buffer }>();

  function page(responseRef: string, start: number, maximumBytes: number, toolCallId: string,
    pack: (value: ResponsePage) => unknown): ResponsePage {
    const entry = saved.get(responseRef);
    if (entry === undefined) throw new Error("central_response_expired_inspect_original_state_before_retrying");

    if (!Number.isSafeInteger(start) || start < 0 || start > entry.bytes.length
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 4 || maximumBytes > CENTRAL_RESPONSE_PAGE_BYTES
      || start < entry.bytes.length && (entry.bytes[start]! & 0xc0) === 0x80) throw new Error("central_response_range_invalid");

    const bytes = entry.bytes, sourceHash = contentHashOf(entry.output), suffix = bytes.subarray(start).toString("utf8");

    function fragment(limit: number): ResponsePage {
      const text = cutToBytes(suffix, limit);
      const end = start + Buffer.byteLength(text, "utf8");
      return { status: "response_page", responseRef, sourceHash, unit: "utf8_bytes",
        start, end, totalBytes: bytes.length, nextStart: end < bytes.length ? end : null, text };
    }

    const full = fragment(maximumBytes);
    if (fits(JSON.stringify(pack(full)), toolCallId)) return full;

    let low = 4, high = maximumBytes, best = fragment(4);
    if (!fits(JSON.stringify(pack(best)), toolCallId)) throw new Error("central_response_metadata_capacity_inspect_original_state_before_retrying");

    while (low <= high) {
      const middle = Math.floor((low + high) / 2), candidate = fragment(middle);
      if (fits(JSON.stringify(pack(candidate)), toolCallId)) {
        best = candidate;
        low = middle + 1;
      }
      else high = middle - 1;
    }

    return best;
  }

  function read(responseRef: string, start = 0, maximumBytes = CENTRAL_RESPONSE_PAGE_BYTES, toolCallId = "") {
    return page(responseRef, start, maximumBytes, toolCallId, value => value);
  }

  return {
    read,

    render(value: unknown, toolCallId = ""): string {
      const output = JSON.stringify(value);
      if (output === undefined) throw new Error("central_response_not_serializable");

      const size = Buffer.byteLength(output, "utf8");

      if (fits(output, toolCallId)) return output;

      if (size > CAPACITY) throw new Error("central_response_capacity_inspect_original_state_before_retrying");

      const responseRef = `central-response:${contentHashOf(output)}`;

      saved.set(responseRef, { output, bytes: Buffer.from(output, "utf8") });

      while (saved.size > 8) saved.delete(saved.keys().next().value!);

      const pack = (firstPage: ReturnType<typeof read>) => ({ status: "paged_response", responseRef, totalBytes: size,
        instruction: "Read every page with central_learning operation=read_response, this responseRef and nextStart. Reassemble the exact JSON before using its original fields. Pages are transport fragments, not independent evidence. If expired, inspect the original state; do not blindly repeat a mutating operation.",
        firstPage });

      return JSON.stringify(pack(page(responseRef, 0, CENTRAL_RESPONSE_PAGE_BYTES, toolCallId, pack)));
    },
  };
}

/** This is the existing reducer's tool_result payload, including its original
 * call id. Measuring output alone misses the second copy and JSON escaping. */
function fits(output: string, toolCallId: string): boolean {
  return Buffer.byteLength(output, "utf8") <= MAX_TOOL_OUTPUT_BYTES
    && Buffer.byteLength(JSON.stringify({ toolCallId, status: "succeeded", value: { result: JSON.parse(output) },
      output, truncated: false }), "utf8") <= MAX_PAYLOAD_BYTES;
}
