import { createHash } from "node:crypto";
import type { CompactWindow } from "../ports/compaction.js";
import type { PersistablePromptInputIdentity } from "../ports/prompt-input.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";

/** Operation addresses do not change input bytes. Adapter proof is required
 * before this distinction can enable cross-turn metering; native ownership
 * scope checks remain at the adapter's independent restore boundary. */
export function capturePersistableInputIdentity(provider: ProviderPort, request: ProviderRequest,
  window: CompactWindow | undefined): PersistablePromptInputIdentity | undefined {
  const binding = inputBinding(provider, request);
  if (binding === undefined) return undefined;

  const excluded = new Set(["attemptId", "observeReturn", "continuationScope", "model", "messages", "tools",
    "maxOutputTokens", "systemPrompt", "systemPromptAppend"]);
  const settings = Object.fromEntries(Object.entries(request).filter(([key]) => !excluded.has(key)));

  return { inputBindingDigest: binding, settingsDigest: digestOf(["input-settings-v1", settings]),
    // Core transcript coordinates are remapped to journal coordinates by the
    // writer. Stable window content plus the actual ordered input commitment
    // bind the projection without confusing those two sequence domains.
    windowDigest: digestOf(["input-window-v1", window === undefined ? null
      : [window.formatVersion, window.windowId, window.summary]]) };
}

function inputBinding(provider: ProviderPort, request: ProviderRequest): string | undefined {
  try {
    const value = provider.inputBindingDigest?.(request);
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  } catch {
    // An optional pure observation cannot interrupt execution or certify input.
    return undefined;
  }
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
