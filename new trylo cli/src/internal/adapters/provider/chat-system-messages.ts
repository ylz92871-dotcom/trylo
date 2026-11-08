import type { ProviderMessage } from "../../ports/provider.js";

/** Measured AMD/DeepSeek Chat requests with a trailing system message produced
 * orphan think tokens or empty reports; AMD/Qwen3.8-Flash-Next rejects them.
 * Keep every system fact, in order,
 * in a single leading segment; the gateway's internal template is not assumed.
 * This is wire compatibility, never a stripper for model-generated output.
 */
export function chatSystemMessages(
  endpoint: string,
  model: string,
  messages: readonly ProviderMessage[],
): readonly ProviderMessage[] {
  if (!isMeasuredProfile(endpoint, model)) return messages;

  const systems = messages.filter(message => message.role === "system");
  if (systems.length === 0 || (systems.length === 1 && messages[0]?.role === "system")) return messages;

  // Do not silently repair exotic/invalid system payloads or discard media.
  // Their original wire shape remains the provider's responsibility.
  if (systems.some(message => (message.attachments?.length ?? 0) > 0 ||
    message.toolCalls !== undefined || message.toolCallId !== undefined)) return messages;

  return [
    { role: "system", content: systems.map(message => message.content).join("\n\n") },
    ...messages.filter(message => message.role !== "system"),
  ];
}

function isMeasuredProfile(endpoint: string, model: string): boolean {
  if (!/^(?:deepseek-|qwen3\.8-flash-next$)/i.test(model.split("/").at(-1) ?? "")) return false;
  try {
    return new URL(endpoint).hostname === "developer.amd.com.cn";
  } catch {
    // A malformed URL cannot identify this profile; transport retains its
    // existing typed failure rather than having this helper mask it.
    return false;
  }
}
