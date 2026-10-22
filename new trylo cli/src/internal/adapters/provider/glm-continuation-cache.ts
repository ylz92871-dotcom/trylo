import type { ProviderMessage } from "../../ports/provider.js";
import { assistantKey, type NativeCheckpointState } from "./glm-continuation-checkpoint.js";
import { CHARS_PER_TOKEN } from "../../compaction/token-estimate.js";

const MAX_CACHE_CHARS = 1_048_576;
const MAX_ENTRIES = 32;
type Entry = { readonly key: string; readonly state: NativeCheckpointState; readonly chars: number };

/**
 * What the cache can say about the current request's assistant messages.
 *
 * `matched` carries the state, not just reasoning: a message paired with an
 * `absent` marker is *answered* (the provider sent no native fields), while a
 * message paired with nothing at all is merely unknown. Collapsing the two is
 * what made "no native data" look like "lost native data".
 */
export type CacheLookup = {
  readonly matched: ReadonlyMap<ProviderMessage, NativeCheckpointState>;
  /** Key present but with a different occurrence count: ambiguous, never guessed. */
  readonly ambiguous: ReadonlySet<ProviderMessage>;
};

function charsOf(state: NativeCheckpointState): number {
  return state.kind === "native" ? state.assistant.reasoning.length : 0;
}

function keyOf(state: NativeCheckpointState): string {
  const identity = state.kind === "native" ? state.assistant : state.identity;
  return assistantKey(identity.text, identity.calls);
}

/**
 * Tool ids may repeat across responses/turns. Keep each occurrence, then pair
 * complete ordered groups. A compacted/evicted ambiguous subset is reported as
 * ambiguous; choosing the newest value would attach another response's native
 * state.
 */
export function createGlmContinuationCache() {
  const entries: Entry[] = [];
  let chars = 0;

  function matching(messages: ReadonlyArray<ProviderMessage>): CacheLookup {
    const groups = new Map<string, ProviderMessage[]>(), matched = new Map<ProviderMessage, NativeCheckpointState>();
    const ambiguous = new Set<ProviderMessage>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const key = assistantKey(message.content, message.toolCalls ?? []);
      const group = groups.get(key) ?? [];
      group.push(message); groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const values = entries.filter(entry => entry.key === key);
      if (values.length === 0 || group.length !== values.length) {
        if (values.length > 0) for (const message of group) ambiguous.add(message);
        continue;
      }
      group.forEach((message, index) => matched.set(message, values[index]!.state));
    }
    return { matched, ambiguous };
  }

  return {
    clear() { entries.length = 0; chars = 0; },
    /** Rebind the just-completed occurrence without adding a duplicate or
     * evicting history. Native payload and its bounded size must stay intact.
     */
    replaceLast(expected: NativeCheckpointState, replacement: NativeCheckpointState): boolean {
      const last = entries.at(-1);
      if (last?.state !== expected || charsOf(replacement) !== last.chars) return false;
      entries[entries.length - 1] = { key: keyOf(replacement), state: replacement, chars: last.chars };
      return true;
    },
    /** Retains one state, returning the keys it had to evict to stay bounded. */
    retain(state: NativeCheckpointState): readonly string[] {
      const evicted: string[] = [];
      const incoming = charsOf(state);
      while (entries.length >= MAX_ENTRIES || chars + incoming > MAX_CACHE_CHARS) {
        const oldest = entries.shift();
        if (oldest === undefined) break;
        chars -= oldest.chars;
        evicted.push(oldest.key);
      }
      entries.push({ key: keyOf(state), state, chars: incoming });
      chars += incoming;
      return evicted;
    },
    matching,
    estimateOverheadTokens(messages: ReadonlyArray<ProviderMessage>) {
      let tokens = 0;
      for (const state of matching(messages).matched.values()) {
        if (state.kind !== "native") continue;
        tokens += Math.ceil(Buffer.byteLength(state.assistant.reasoning, "utf8") / CHARS_PER_TOKEN);
      }
      return tokens;
    },
  };
}
