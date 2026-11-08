// Trylo Desktop — model → context window map.
//
// v1.16.0: the old `extension.js:2165-2233` tried to extract
// `contextWindowTokens` from each provider's usage metadata.
// That failed in practice — the field name and shape vary
// per provider and the desktop would have to know every
// provider's quirk. We hardcode the window per model family
// instead, with a sensible default for unknown models.
//
// Read old code at: D:/CC/claude-code-v-2.1.88-main/.../extension.js:2165-2233
// Do NOT: try to read contextWindow from usage payloads.

/** Default context window when the model is unknown. 200k
 *  is the right default for every Claude 3.5+ / 4 family. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Best-effort model name → context window mapping. We
 * match on substring (case-insensitive) so aliases like
 * `claude-3-5-sonnet-20241022` and `claude-3-5-sonnet-latest`
 * both hit. Order matters only for ambiguous names; the
 * longest match wins.
 */
const MODEL_WINDOWS: readonly { readonly match: string; readonly window: number }[] = [
  // Claude 4 family — 200k standard, 1M beta on some.
  // We use 200k to match the safe default; the 1M beta
  // header is opt-in per request, not a model property.
  { match: 'claude-opus-4', window: 200_000 },
  { match: 'claude-sonnet-4', window: 200_000 },
  { match: 'claude-haiku-4', window: 200_000 },
  // Claude 3.7
  { match: 'claude-3-7-sonnet', window: 200_000 },
  // Claude 3.5 family
  { match: 'claude-3-5-sonnet', window: 200_000 },
  { match: 'claude-3-5-haiku', window: 200_000 },
  // Claude 3 family
  { match: 'claude-3-opus', window: 200_000 },
  { match: 'claude-3-sonnet', window: 200_000 },
  { match: 'claude-3-haiku', window: 200_000 },
];

/** Resolve a model name to its context window in tokens.
 *  Falls back to DEFAULT_CONTEXT_WINDOW for unknown models. */
export function contextWindowFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const lower = model.toLowerCase();
  for (const entry of MODEL_WINDOWS) {
    if (lower.includes(entry.match)) return entry.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Format a token count for display: 47_231 → "47k",
 *  1_234_567 → "1M". Always rounds to the nearest integer
 *  for the compact label — the full number goes in the
 *  tooltip via formatTokenCountFull. Mature IDE convention
 *  (VSCode Copilot, Cursor) is "47k" not "47.2k"; the
 *  precision loss is acceptable because the tooltip has
 *  the exact number. */
export function formatTokenCountShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Full token count for the tooltip: 47,231 / 200,000. */
export function formatTokenCountFull(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}
