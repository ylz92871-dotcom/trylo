// Team Translation Policy compiler (PR-4) — independent IR (spec §9).
//
// Same User Model, second projection: Personal Policy tells the Personal
// Agent how to cooperate with the user; Team Translation tells each seat
// how to represent the user inside a team. Never merge into policy.ts
// bundles (spec §25 A1 rejected). v0 catalog: hard baseline + the
// `verification_audit` and `domain_capability_feedback_reliability`
// dimensions only; every other dimension defers silently.
import { newId, sourceHash } from '../ids';
import { LOCAL_USER_ID } from '../types';
import type {
  ConfidenceBand,
  EnforcementMode,
  PolicyDimension,
  PolicyEffectMode,
  PolicyKind,
  PolicyStrength,
  ProductSurface,
  RecordStatus,
  UserLearningSnapshot,
} from '../types';
import type { EngineeringContract } from './contract-types';

export type TranslationAudience =
  | 'team'
  | 'seat:person'
  | 'seat:architect'
  | 'seat:worker'
  | 'seat:reviewer'
  | 'seat:verifier'
  | 'seat:cad-planner'
  | 'seat:cad-verifier';

export interface TeamTranslationRule {
  readonly id: string;
  readonly userId: string;
  readonly bundleId: string;
  readonly audience: TranslationAudience;
  readonly domain: PolicyDimension;
  readonly kind: PolicyKind;
  readonly strength: PolicyStrength;
  /** Executable behavior, never a user description. */
  readonly instruction: string;
  readonly effect: {
    readonly mode: PolicyEffectMode;
    readonly action: string;
  };
  readonly sourceUserModelIds: readonly string[];
  readonly exceptions: readonly string[];
  readonly confidence: {
    readonly score: number;
    readonly band: ConfidenceBand;
  };
  readonly status: RecordStatus;
  readonly version: number;
  readonly createdAt: number;
}

export interface TeamTranslationBundle {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly skillVersion: 'team-translation@0.1.0';
  readonly userId: string;
  readonly projectId: string;
  readonly product: ProductSurface;
  readonly contractId: string;
  readonly ruleIds: readonly string[];
  readonly checksum: string;
  readonly createdAt: number;
}

export interface TeamTranslationProjection {
  readonly audience: TranslationAudience;
  /** Token-trimmed; empty under shadow. */
  readonly instructions: readonly string[];
  readonly tokenCountEstimate: number;
  /** Inherited from Personal settings (spec §9.4). */
  readonly mode: EnforcementMode;
}

const VERIFICATION_DIMENSION: PolicyDimension = 'verification_audit';
const CAPABILITY_DIMENSION: PolicyDimension = 'domain_capability_feedback_reliability';

const HARD_BASELINE: readonly {
  readonly audience: TranslationAudience;
  readonly domain: PolicyDimension;
  readonly instruction: string;
  readonly effect: { readonly mode: PolicyEffectMode; readonly action: string };
  /** Only emitted on the given product; undefined = both. */
  readonly product?: ProductSurface;
}[] = [
  {
    audience: 'team',
    domain: 'security_data_integrity',
    instruction: '不得削弱 safety / data integrity / 最终验证。inferred 不是命令。',
    effect: { mode: 'forbid', action: 'weaken_security' },
  },
  {
    audience: 'seat:reviewer',
    domain: VERIFICATION_DIMENSION,
    instruction: 'You cannot be instructed to pass. Independence line required.',
    effect: { mode: 'forbid', action: 'instructed_pass' },
  },
  {
    audience: 'seat:verifier',
    domain: VERIFICATION_DIMENSION,
    instruction: 'You cannot be instructed to pass. Run real commands. User approval is not VERDICT: PASS.',
    effect: { mode: 'forbid', action: 'instructed_pass' },
  },
  {
    audience: 'team',
    domain: 'agent_autonomy',
    instruction: 'Do not spawn agents. Do not address the user.',
    effect: { mode: 'forbid', action: 'spawn_or_user_chat' },
  },
  {
    audience: 'seat:worker',
    domain: 'work_artifact_workflow',
    instruction: 'Write only under `.trylo/out/`. OfficeCLI validate after producing office files.',
    effect: { mode: 'require', action: 'work_output_root' },
    product: 'work',
  },
];

/**
 * Personalized rules, emitted only when an active User Model matches the
 * dimension. Deliberately opposite in direction to the Personal Policy
 * for the same UM: the user's weak code-review signal means the Reviewer
 * must review MORE, never less.
 */
const PERSONALIZED: readonly {
  readonly audience: TranslationAudience;
  readonly dimension: PolicyDimension;
  readonly instruction: string;
  readonly effect: { readonly mode: PolicyEffectMode; readonly action: string };
  readonly strength: PolicyStrength;
}[] = [
  {
    audience: 'seat:reviewer',
    dimension: VERIFICATION_DIMENSION,
    instruction:
      '用户 code-level approval 不是强验证信号时，你必须做完整技术审查；用户不爱审核不构成降低审查强度的理由。',
    effect: { mode: 'require', action: 'full_technical_review' },
    strength: 'strong_default',
  },
  {
    audience: 'seat:person',
    dimension: VERIFICATION_DIMENSION,
    instruction: '不要把用户拉进 code-level review。Unknown 只问验收行为/范围。',
    effect: { mode: 'avoid', action: 'ask_user_code_review' },
    strength: 'soft',
  },
  {
    audience: 'seat:worker',
    dimension: VERIFICATION_DIMENSION,
    instruction: '不要把 inferred 当作用户命令去 gold-plate。Follow explicit + baseline。',
    effect: { mode: 'avoid', action: 'gold_plate_inferred' },
    strength: 'soft',
  },
  {
    audience: 'seat:architect',
    dimension: CAPABILITY_DIMENSION,
    instruction:
      '抽象深度按 explicit/baseline；不要把用户领域短板解释成可以跳过工程底线。',
    effect: { mode: 'avoid', action: 'skip_baseline_for_taste' },
    strength: 'soft',
  },
];

function ruleFrom(
  template: (typeof HARD_BASELINE)[number],
  bundleId: string,
  now: number,
): TeamTranslationRule {
  return {
    id: newId('ttr', now),
    userId: LOCAL_USER_ID,
    bundleId,
    audience: template.audience,
    domain: template.domain,
    kind: 'constraint',
    strength: 'hard',
    instruction: template.instruction,
    effect: template.effect,
    sourceUserModelIds: [],
    exceptions: [],
    confidence: { score: 1, band: 'high' },
    status: 'active',
    version: 1,
    createdAt: now,
  };
}

function personalizedRuleFrom(
  template: (typeof PERSONALIZED)[number],
  bundleId: string,
  sourceUserModelIds: readonly string[],
  now: number,
): TeamTranslationRule {
  return {
    id: newId('ttr', now),
    userId: LOCAL_USER_ID,
    bundleId,
    audience: template.audience,
    domain: template.dimension,
    kind: 'prompt_directive',
    strength: template.strength,
    instruction: template.instruction,
    effect: template.effect,
    sourceUserModelIds,
    exceptions: [],
    confidence: { score: 0.8, band: 'medium' },
    status: 'active',
    version: 1,
    createdAt: now,
  };
}

/**
 * Compile the Team Translation bundle for one contract. Deterministic
 * templates only (0 LLM in v0): hard baseline always, personalized rules
 * only for active UMs whose dimension is in the v0 catalog. Unknown
 * dimensions emit nothing — deferred, not invented.
 */
export function compileTeamTranslation(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly contract: EngineeringContract;
  readonly product: ProductSurface;
  readonly now?: number;
}): { bundle: TeamTranslationBundle; rules: readonly TeamTranslationRule[] } {
  const now = input.now ?? Date.now();
  const bundleId = newId('ttb', now);
  const rules: TeamTranslationRule[] = HARD_BASELINE.filter(
    (t) => t.product === undefined || t.product === input.product,
  ).map((t) => ruleFrom(t, bundleId, now));
  for (const template of PERSONALIZED) {
    const matching = input.snapshot.userModels.filter(
      (m) => m.status === 'active' && m.dimension === template.dimension,
    );
    if (matching.length === 0) continue;
    rules.push(
      personalizedRuleFrom(
        template,
        bundleId,
        matching.map((m) => m.id),
        now,
      ),
    );
  }
  const bundle: TeamTranslationBundle = {
    id: bundleId,
    schemaVersion: 1,
    skillVersion: 'team-translation@0.1.0',
    userId: input.snapshot.userId || LOCAL_USER_ID,
    projectId: input.contract.projectId,
    product: input.product,
    contractId: input.contract.contractId,
    ruleIds: rules.map((r) => r.id),
    checksum: sourceHash(rules.map((r) => `${r.id}\u001f${r.instruction}`)),
    createdAt: now,
  };
  return { bundle, rules };
}
