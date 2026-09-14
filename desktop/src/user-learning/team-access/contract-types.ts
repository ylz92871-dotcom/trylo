// Trylo Team Access — Engineering Contract canonical types (PR-1).
//
// Spec §8.3 is the authority. The same field names must exist in:
//   - desktop/src/user-learning/team-access/contract-types.ts  (this side, compiler source)
//   - trylo cli/src/tools/AgentTool/team-roster/engineering-contract.ts (CLI parse/briefing copy)
//   - desktop/src/surfaces/shared/engineering-contract.ts      (UI read-only subset)
// A lock test asserts the three copies stay aligned. user-learning must
// not import surfaces; desktop must not import trylo-cli sources.
import type { ProductSurface } from '../types';

export const ENGINEERING_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Wrapper tag around the serialized contract inside prompts. */
export const CONTRACT_TAG = 'trylo_engineering_contract';

export type ContractAuthority = 'explicit' | 'inferred' | 'baseline' | 'recommendation';

export type ContractClauseField =
  | 'goal'
  | 'functional'
  | 'nfr'
  | 'architecture'
  | 'ux'
  | 'autonomy'
  | 'risk'
  | 'review'
  | 'security'
  | 'acceptance'
  | 'prohibited'
  | 'out_of_scope'
  | 'tradeoff';

export interface ContractClause {
  readonly id: string;
  readonly authority: ContractAuthority;
  /** One meaning per clause, ≤ MAX_CLAUSE_CHARS. User original text for explicit. */
  readonly text: string;
  readonly field: ContractClauseField;
}

export interface InferredClause extends ContractClause {
  readonly authority: 'inferred';
  readonly confidence: number;
  readonly uncertainty: 'low' | 'medium' | 'high';
  /** Empty when the compiler ran deterministic fallback. */
  readonly sourceUserModelIds: readonly string[];
}

export interface EngineeringContractProvenance {
  readonly compiledAt: number;
  readonly compiler: 'deterministic_fallback' | 'template' | 'llm';
  readonly userModelIds: readonly string[];
  readonly personalPolicyBundleId?: string;
  readonly translationBundleId?: string;
  readonly preferenceStubUsed: boolean;
  readonly sourceHash: string;
}

export interface EngineeringContract {
  readonly schemaVersion: typeof ENGINEERING_CONTRACT_SCHEMA_VERSION;
  readonly contractId: string;
  /** +1 per revision inside one TeamRun; supersedes names the previous id. */
  readonly version: number;
  readonly supersedes?: string;
  readonly product: ProductSurface;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly personConversationId: string;
  readonly teamRunId?: string;
  readonly task: {
    /** ≤ 24 chars; feeds TaskSummary.title. */
    readonly title: string;
    readonly goal: string;
    /** ≤ 80 chars; feeds TaskSummary.oneLiner. */
    readonly oneLiner: string;
  };
  readonly authority: {
    /** May be empty — "none stated" is a legal contract. */
    readonly explicit: readonly ContractClause[];
    /** May be empty — still a legal contract (locked by test). */
    readonly inferred: readonly InferredClause[];
    /** Never empty; the security floor clause guarantees ≥ 1. */
    readonly baseline: readonly ContractClause[];
    readonly recommendation: readonly ContractClause[];
  };
  readonly provenance: EngineeringContractProvenance;
}

export const MAX_CONTRACT_TOKENS = 800;
export const MAX_CLAUSE_CHARS = 160;
export const MAX_INFERRED_CLAUSES = 6;
export const MAX_EXPLICIT_CLAUSES = 8;

/**
 * The seat ids, duplicated locally from
 * `surfaces/shared/seats.ts` / CLI `TRYLO_TEAM_SEAT_IDS` (same order).
 * user-learning must not import surfaces, so the union is restated here
 * and locked by a three-way test. CAD seats ride the Work surface roster.
 */
export type TeamAccessSeatId =
  | 'person'
  | 'architect'
  | 'worker'
  | 'reviewer'
  | 'verifier'
  | 'cad-planner'
  | 'cad-verifier';

export const TEAM_ACCESS_SEAT_IDS: readonly TeamAccessSeatId[] = [
  'person',
  'architect',
  'worker',
  'reviewer',
  'verifier',
  'cad-planner',
  'cad-verifier',
];
