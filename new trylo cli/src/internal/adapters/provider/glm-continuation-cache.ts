import type { ProviderMessage } from "../../ports/provider.js";
import { assistantKey, type NativeCheckpointState } from "./glm-continuation-checkpoint.js";
import { CHARS_PER_TOKEN } from "../../compaction/token-estimate.js";

const MAX_CACHE_CHARS = 1_048_576;
const MAX_CACHE_BYTES = 4_194_304;
// Charge metadata even for absent/rejected markers. Small responses must not
// lose native state at an arbitrary response count, but empty entries stay bounded.
const ENTRY_OVERHEAD_BYTES = 256;
type Entry = { readonly key: string; readonly state: NativeCheckpointState; readonly chars: number; readonly bytes: number };

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

function entryOf(state: NativeCheckpointState): Entry {
  const key = keyOf(state);
  return { key, state, chars: charsOf(state),
    bytes: Buffer.byteLength(JSON.stringify(state), "utf8") + Buffer.byteLength(key, "utf8") + ENTRY_OVERHEAD_BYTES };
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
  let bytes = 0;

  function matching(messages: ReadonlyArray<ProviderMessage>): CacheLookup {
    const groups = new Map<string, ProviderMessage[]>(), matched = new Map<ProviderMessage, NativeCheckpointState>();
    const ambiguous = new Set<ProviderMessage>();
    const statesByKey = new Map<string, NativeCheckpointState[]>();
    for (const entry of entries) {
      const states = statesByKey.get(entry.key) ?? [];
      states.push(entry.state); statesByKey.set(entry.key, states);
    }
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const key = assistantKey(message.content, message.toolCalls ?? []);
      const group = groups.get(key) ?? [];
      group.push(message); groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const values = statesByKey.get(key) ?? [];
      if (values.length === 0 || group.length !== values.length) {
        if (values.length > 0) for (const message of group) ambiguous.add(message);
        continue;
      }
      group.forEach((message, index) => matched.set(message, values[index]!));
    }
    return { matched, ambiguous };
  }

  return {
    clear() { entries.length = 0; chars = 0; bytes = 0; },
    /** Rebind the just-completed occurrence without adding a duplicate or
     * evicting history. Native payload and its bounded size must stay intact.
     */
    replaceLast(expected: NativeCheckpointState, replacement: NativeCheckpointState): boolean {
      const last = entries.at(-1);
      if (last?.state !== expected || charsOf(replacement) !== last.chars) return false;
      const rebound = entryOf(replacement);
      if (bytes - last.bytes + rebound.bytes > MAX_CACHE_BYTES) return false;
      entries[entries.length - 1] = rebound;
      bytes += rebound.bytes - last.bytes;
      return true;
    },
    /** Retains one state, returning the keys it had to evict to stay bounded. */
    retain(state: NativeCheckpointState): readonly string[] {
      const evicted: string[] = [];
      const incoming = entryOf(state);
      // Refusing one oversized entry must not first destroy usable history.
      if (incoming.chars > MAX_CACHE_CHARS || incoming.bytes > MAX_CACHE_BYTES) return [incoming.key];
      while (chars + incoming.chars > MAX_CACHE_CHARS || bytes + incoming.bytes > MAX_CACHE_BYTES) {
        const oldest = entries.shift();
        if (oldest === undefined) break;
        chars -= oldest.chars;
        bytes -= oldest.bytes;
        evicted.push(oldest.key);
      }
      entries.push(incoming);
      chars += incoming.chars;
      bytes += incoming.bytes;
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
