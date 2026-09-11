// Trylo Desktop — canonical input digest (§6.2 audit correlate).
//
// Shared by the risk classifier router and every package classifier. Kept in
// its own module so the classifier files import each other only through
// types — no runtime import cycle.

import { hashIdentity } from './runtime-fingerprint';

/** Key-sorted canonical JSON so equal inputs always digest equally. */
export function stableStringifyInput(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringifyInput).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyInput((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * FNV-64 digest of the canonicalised input. In-process correlation only —
 * the same trade-off as the runtime fingerprint, never evidence-grade and
 * never persisted as such (§6.2: audits carry no raw input).
 */
export function inputDigestOf(input: Readonly<Record<string, unknown>>): string {
  return hashIdentity([stableStringifyInput(input)]);
}
