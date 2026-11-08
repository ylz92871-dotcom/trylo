import type { Transcript } from "../protocol/transcript.js";
import { assertExhaustive } from "../contract/index.js";
import type { ProviderMessage, ProviderOutboundToolCall } from "../ports/provider.js";
import { pairRejectedToolMessages } from "./rejected-tool-messages.js";
import type { ImageReference } from "../protocol/image-reference.js";

/**
 * Canonical transcript -> provider request messages.
 *
 * Reasoning blocks are never sent back to the provider. Redacted reasoning in
 * particular must not leave the loop: it is display-only and provider-specific.
 */
export function transcriptToMessages(transcript: Transcript): ReadonlyArray<ProviderMessage> {
  const messages: ProviderMessage[] = [];
  let assistantText = "";
  let assistantToolCalls: ProviderOutboundToolCall[] = [];
  let images: ImageReference[] = [];
  const flushImages = (): void => {
    if (images.length === 0) return;
    // Keep a batch's tool results contiguous before the multimodal input.
    messages.push({ role: "user", content: "Images returned by the preceding tools.", imageReferences: images });
    images = [];
  };

  const flushAssistant = (): void => {
    if (assistantText.length === 0 && assistantToolCalls.length === 0) {
      return;
    }

    messages.push({
      role: "assistant",
      content: assistantText,
      ...(assistantToolCalls.length > 0 ? { toolCalls: assistantToolCalls } : {}),
    });
    assistantText = "";
    assistantToolCalls = [];
  };

  for (const item of transcript) {
    if (item.kind !== "tool_result") flushImages();
    switch (item.kind) {
      case "system":
        flushAssistant();
        messages.push({ role: "system", content: item.text });
        break;
      case "user":
        flushAssistant();
        messages.push({ role: "user", content: item.text });
        break;
      case "assistant_text":
        assistantText += item.text;
        break;
      case "assistant_reasoning":
        // Deliberately dropped: never replayed to a provider.
        break;
      case "tool_call":
        assistantToolCalls = [
          ...assistantToolCalls,
          { toolCallId: item.toolCallId, name: item.name, arguments: item.arguments,
            ...(item.originalArguments === undefined ? {} : { originalArguments: item.originalArguments }) },
        ];
        break;
      case "tool_result":
        flushAssistant();
        messages.push({
          role: "tool",
          content: item.output,
          toolCallId: item.toolCallId,
        });
        images.push(...item.images ?? []);
        break;
      default: {
        assertExhaustive(item);
        break;
      }
    }
  }

  flushAssistant();
  flushImages();
  const rejected = new Map(transcript.flatMap(item => item.kind === "tool_result" && item.outcome === "failed" && item.output.startsWith("invalid_arguments") ? [[item.toolCallId, item.name] as const] : []));

  return pairRejectedToolMessages(messages, rejected);
}

export function nextTranscriptSequence(transcript: Transcript): number {
  let max = -1;

  for (const item of transcript) {
    if (item.sequence > max) {
      max = item.sequence;
    }
  }

  return max + 1;
}
