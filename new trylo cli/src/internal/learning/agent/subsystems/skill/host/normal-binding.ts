import type { HermesToolProfile } from "./client.js";
import type { createHermesNativeContext } from "./native-context.js";
import { normalContextPrompt, normalContextTools } from "./normal-context.js";

/** Bind native discovery/observation once; the host lends the actual final table later. */
export function bindHermesNormalContext(profile: HermesToolProfile,
  native: Pick<ReturnType<typeof createHermesNativeContext>, "context" | "recordView">, warn: (code: string) => void) {
  return { profile,
    async promptForTools(mountedTools: readonly string[] | undefined, signal?: AbortSignal) {
      if (normalContextTools(profile, mountedTools) === undefined) return "";
      try {
        const context = await native.context({ maxPromptChars: 15_000,
          ...(mountedTools === undefined ? {} : { availableTools: mountedTools, availableToolsets: [] }) }, signal);
        return context.ok ? normalContextPrompt(context.prompt, profile,
          mountedTools === undefined ? {} : { mountedTools }) : "";
      } catch {
        if (!signal?.aborted) warn("hermes_normal_context_unavailable");
        return "";
      }
    },
    observer: { viewed: (input: { readonly name: string }, signal?: AbortSignal) => native.recordView(input, signal), warn },
  };
}
