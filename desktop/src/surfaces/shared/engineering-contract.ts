/**
 * Engineering Contract — UI read-only subset (PR-1).
 *
 * Surfaces only need the field-name constants to project a
 * `ContractSummaryDto` onto `TaskSummary`; the full compiler types stay
 * in `user-learning/team-access/` (spec §8.4: do not pull compiler types
 * into surfaces). The `engineering-contract.test.ts` lock test asserts
 * the key names match both the user-learning source and the CLI copy.
 */

export const ENGINEERING_CONTRACT_SCHEMA_VERSION_UI = 1 as const;

/** Wrapper tag around the serialized contract inside prompts. */
export const CONTRACT_TAG_UI = 'trylo_engineering_contract';

/** Authority keys, in prompt display order. Never flattened. */
export const CONTRACT_AUTHORITY_KEYS_UI = [
  'explicit',
  'inferred',
  'baseline',
  'recommendation',
] as const;

export type ContractAuthorityUi = (typeof CONTRACT_AUTHORITY_KEYS_UI)[number];

/** The three TaskSummary rows fed from a contract summary. */
export const CONTRACT_SUMMARY_KEYS_UI = ['explicit', 'inferred', 'baseline'] as const;

/**
 * Read-only projection input mirroring the user-learning
 * `ContractSummaryDto` field names (locked by the three-way test).
 * surfaces must not import user-learning, so the shape is restated.
 */
export interface ContractSummaryLike {
  readonly title: string;
  readonly goal: string;
  readonly oneLiner: string;
  readonly explicit?: string;
  readonly inferred?: string;
  readonly baseline?: string;
}
