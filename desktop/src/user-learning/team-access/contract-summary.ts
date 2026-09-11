// ContractSummaryDto projection (PR-2).
//
// Spec §8.4: the DTO keeps user-learning decoupled from surfaces — it
// must not import TaskSummary. Confidence stays visible in the inferred
// line ("(conf 0.76)"); dropping it would read as a user wish.
import type { EngineeringContract } from './contract-types';

export interface ContractSummaryDto {
  readonly title: string;
  readonly goal: string;
  readonly oneLiner: string;
  readonly explicit?: string;
  readonly inferred?: string;
  readonly baseline?: string;
}

function joinClauses(
  c: EngineeringContract,
  authority: 'explicit' | 'baseline',
): string | undefined {
  const texts = c.authority[authority].map((clause) => clause.text);
  if (texts.length === 0) return undefined;
  return texts.join('；');
}

function joinInferred(c: EngineeringContract): string | undefined {
  const texts = c.authority.inferred.map(
    (clause) => `${clause.text} (conf ${clause.confidence.toFixed(2)})`,
  );
  if (texts.length === 0) return undefined;
  return texts.join('；');
}

/** Contract → DTO. Text truncation is the UI's (clampText) job. */
export function contractSummaryFromContract(c: EngineeringContract): ContractSummaryDto {
  return {
    title: c.task.title,
    goal: c.task.goal,
    oneLiner: c.task.oneLiner,
    explicit: joinClauses(c, 'explicit'),
    inferred: joinInferred(c),
    baseline: joinClauses(c, 'baseline'),
  };
}
