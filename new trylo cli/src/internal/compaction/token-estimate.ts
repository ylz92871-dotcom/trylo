import type {
  ProviderMessage,
  ProviderOutboundToolCall,
  ProviderToolSpec,
} from "../ports/provider.js";

/**
 * Local text-token basis for the final request (WP09.1 / C35).
 *
 * A provider request is more than the text of its messages: assistant turns
 * carry `toolCalls` whose JSON arguments can dwarf the prose, and the wire
 * carries the tool table itself. Estimate that textual material in UTF-8
 * bytes divided by four, rounded up per message.
 *
 * Visual usage is unknown here: neither compressed file bytes, base64 length
 * nor image detail defines a model's image-token formula. Images therefore
 * leave this text-only lower basis unchanged; it is not a complete multimodal
 * context measurement. Actual provider input usage and context rejection own
 * that missing evidence. This remains a deterministic heuristic, not a
 * tokenizer or a guarantee that the complete request fits.
 */

export const CHARS_PER_TOKEN = 4;

/** Text and tool-call JSON only; image bytes are transport, not text tokens. */
function messageTextBytes(message: ProviderMessage, textBytes = utf8Bytes): number {
  let bytes = textBytes(message.content);
  for (const call of message.toolCalls ?? []) {
    bytes += outboundCallBytes(call, textBytes);
  }
  return bytes;
}

function outboundCallBytes(call: ProviderOutboundToolCall, textBytes: (text: string) => number): number {
  let bytes = textBytes(call.toolCallId + call.name);

  try {
    bytes += textBytes(JSON.stringify(call.originalArguments ?? call.arguments));
  } catch {
    // An unserializable argument object still existed; counting the id and
    // name keeps the estimate monotonic instead of pretending it was empty.
  }

  return bytes;
}

/** The text-only token estimate for one message, rounded up on its own. */
export function estimateMessageTokens(message: ProviderMessage): number {
  return Math.ceil(messageTextBytes(message) / CHARS_PER_TOKEN);
}

/** The text-only token estimate for the messages a request would carry. */
export function estimateMessagesTokens(messages: ReadonlyArray<ProviderMessage>): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateMessageTokens(message);
  }
  return tokens;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Byte-level tokenization can only merge its input bytes. Include standard
 * Unicode normalizations because composition/decomposition can increase byte
 * length. This is a text bound under that tokenizer contract, not an exact
 * count or a bound on unknown chat templates, visuals or custom preprocessors. */
export function boundTextTokens(text: string): number {
  return Math.max(utf8Bytes(text), ...(["NFC", "NFD", "NFKC", "NFKD"] as const).map(form => utf8Bytes(text.normalize(form))));
}

/** The complete supplied message text, including original tool-call JSON. */
export function boundMessagesTextTokens(messages: ReadonlyArray<ProviderMessage>): number {
  return messages.reduce((bytes, message) => bytes + messageTextBytes(message, boundTextTokens), 0);
}

/**
 * The token estimate for the tool table itself (`tools` on the wire).
 *
 * Function definitions are part of every request a mounted catalog produces,
 * so a threshold compared against them without this term under-counts by a
 * constant per run.
 */
export function estimateToolSpecsTokens(specs: ReadonlyArray<ProviderToolSpec>): number {
  return specs.reduce((tokens, spec) => tokens + Math.ceil(toolSpecTextBytes(spec) / CHARS_PER_TOKEN), 0);
}

/** The same byte-level text bound for the actual request's function table. */
export function boundToolSpecsTextTokens(specs: ReadonlyArray<ProviderToolSpec>): number {
  return specs.reduce((bytes, spec) => bytes + toolSpecTextBytes(spec, boundTextTokens), 0);
}

function toolSpecTextBytes(spec: ProviderToolSpec, textBytes = utf8Bytes): number {
  let bytes = textBytes(spec.name + spec.description);

  try {
    bytes += textBytes(JSON.stringify(spec.parameters));
  } catch {
    // Same monotonicity rule as call arguments above.
  }

  return bytes;
}
