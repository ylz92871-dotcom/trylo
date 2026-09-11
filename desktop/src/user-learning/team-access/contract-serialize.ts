// EngineeringContract serialization (PR-1).
//
// Canonical runtime format is JSON (spec §8.6): no yaml dependency exists
// in either package, and the same string feeds prompts and disk files.
// `extractContractFromPrompt` parses the body of a
// `<trylo_engineering_contract>` wrapper; malformed JSON yields null —
// never an empty object.
import {
  CONTRACT_TAG,
  ENGINEERING_CONTRACT_SCHEMA_VERSION,
  type EngineeringContract,
} from './contract-types';

/** JSON string shared by prompt injection and `.trylo/team/**` disk copy. */
export function serializeContract(c: EngineeringContract): string {
  return JSON.stringify(c);
}

/**
 * Parse a serialized contract. Returns null when the JSON is invalid,
 * the schemaVersion is foreign, or required fields are missing. Fails
 * closed: callers must not treat null as an empty contract.
 */
export function parseContractJson(text: string): EngineeringContract | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (c['schemaVersion'] !== ENGINEERING_CONTRACT_SCHEMA_VERSION) return null;
  if (typeof c['contractId'] !== 'string' || c['contractId'] === '') return null;
  if (typeof c['version'] !== 'number') return null;
  if (c['product'] !== 'code' && c['product'] !== 'work') return null;
  if (typeof c['workspaceId'] !== 'string') return null;
  if (typeof c['projectId'] !== 'string') return null;
  if (typeof c['personConversationId'] !== 'string') return null;
  const task = c['task'];
  if (!task || typeof task !== 'object') return null;
  const t = task as Record<string, unknown>;
  if (typeof t['title'] !== 'string') return null;
  if (typeof t['goal'] !== 'string') return null;
  if (typeof t['oneLiner'] !== 'string') return null;
  const authority = c['authority'];
  if (!authority || typeof authority !== 'object') return null;
  const a = authority as Record<string, unknown>;
  for (const key of ['explicit', 'inferred', 'baseline', 'recommendation']) {
    if (!Array.isArray(a[key])) return null;
  }
  if ((a['baseline'] as unknown[]).length < 1) return null;
  if (!c['provenance'] || typeof c['provenance'] !== 'object') return null;
  return value as EngineeringContract;
}

/**
 * Extract and parse the contract wrapped in
 * `<trylo_engineering_contract>…</trylo_engineering_contract>` inside a
 * prompt. No YAML branch: the wrapper always carries JSON.
 */
export function extractContractFromPrompt(prompt: string): EngineeringContract | null {
  const open = `<${CONTRACT_TAG}`;
  const openStart = prompt.indexOf(open);
  if (openStart === -1) return null;
  const openEnd = prompt.indexOf('>', openStart);
  if (openEnd === -1) return null;
  const closeSeq = `</${CONTRACT_TAG}>`;
  const close = prompt.indexOf(closeSeq, openEnd);
  if (close === -1) return null;
  return parseContractJson(prompt.slice(openEnd + 1, close).trim());
}
