import type { OrganizationRecord } from "../../learning/central/organization/contracts.js";
import type { OrganizationKnowledgeProposal, OrganizationPublication } from "./organization-service.js";

export const ORGANIZATION_CAS_ATTEMPTS = 4;

export type OrganizationCasPhase = "recall" | "publication" | "result";

/** Only this pending fixed payload is unwritten; earlier successful facts remain committed. */
export class OrganizationCasBusyError extends Error {
  readonly definiteUnwritten = true;
  readonly attempts = ORGANIZATION_CAS_ATTEMPTS;
  readonly observedRevision?: number;

  constructor(readonly phase: OrganizationCasPhase, observedRevision?: number) {
    super("organization_publication_busy");
    this.name = "OrganizationCasBusyError";
    if (observedRevision !== undefined) this.observedRevision = observedRevision;
  }
}

export interface OrganizationCasRetryBudget { staleAttempts: number; observedRevision?: number }

export const createOrganizationCasRetryBudget = (): OrganizationCasRetryBudget => ({ staleAttempts: 0 });

function busyError(budget: OrganizationCasRetryBudget, phase: OrganizationCasPhase) {
  const observed = budget.observedRevision;
  return new OrganizationCasBusyError(phase, typeof observed === "number" && Number.isSafeInteger(observed) && observed >= 0 ? observed : undefined);
}

/** A shared batch counts only definite stale outcomes, never successful publications. */
export function consumeOrganizationCasStale(budget: OrganizationCasRetryBudget, phase: OrganizationCasPhase): void {
  if (budget.staleAttempts < ORGANIZATION_CAS_ATTEMPTS) budget.staleAttempts++;
  if (budget.staleAttempts >= ORGANIZATION_CAS_ATTEMPTS) throw busyError(budget, phase);
}

type OrganizationCasStop = { readonly status: "disabled" }
  | { readonly status: "rejected"; readonly reason: string };

export type OrganizationCasRead = { readonly status: "ready"; readonly revision: number } | { readonly status: "stale" } | OrganizationCasStop;

export type OrganizationCasOptions<TRecord extends OrganizationRecord, TResult extends OrganizationPublication | OrganizationKnowledgeProposal> = {
  readonly record: TRecord;
  readonly phase: OrganizationCasPhase;
  readonly read: () => Promise<OrganizationCasRead>;
  readonly publish: (sameRecord: TRecord, expectedRevision: number) => Promise<TResult>;
  readonly enabled: () => boolean;
  readonly signal?: AbortSignal;
  readonly budget?: OrganizationCasRetryBudget;
};

/** Only a definite, unwritten physical stale may re-read. The original service
 * revalidates the exact same semantic proposal at every fresh Board prefix. */
export async function publishOrganizationWithCas<TRecord extends OrganizationRecord,
  TResult extends OrganizationPublication | OrganizationKnowledgeProposal>(options: OrganizationCasOptions<TRecord, TResult>): Promise<TResult | OrganizationCasStop> {
  const record = options.record;
  const budget = options.budget ?? createOrganizationCasRetryBudget();
  const interrupted = (): OrganizationCasStop | undefined => {
    if (options.signal?.aborted) return { status: "rejected", reason: "organization_cancelled" };
    const enabled = options.enabled();
    if (options.signal?.aborted) return { status: "rejected", reason: "organization_cancelled" };
    return enabled ? undefined : { status: "disabled" };
  };

  for (let attempt = 0; attempt < ORGANIZATION_CAS_ATTEMPTS; attempt++) {
    const beforeRead = interrupted();
    if (beforeRead !== undefined) return beforeRead;

    if (budget.staleAttempts >= ORGANIZATION_CAS_ATTEMPTS) throw busyError(budget, options.phase);

    const current = await options.read();
    const afterRead = interrupted();
    if (afterRead !== undefined) return afterRead;

    if (current.status === "stale") {
      consumeOrganizationCasStale(budget, options.phase);
      continue;
    }

    if (current.status !== "ready") return current;

    const previousRevision = budget.observedRevision;
    if (Number.isSafeInteger(current.revision) && current.revision >= 0 && (previousRevision === undefined
      || !Number.isSafeInteger(previousRevision) || previousRevision < 0 || current.revision > previousRevision)) budget.observedRevision = current.revision;

    const beforeWrite = interrupted();
    if (beforeWrite !== undefined) return beforeWrite;

    const result = await options.publish(record, current.revision);
    const afterWrite = interrupted();
    if (afterWrite !== undefined) return afterWrite;

    if (result.status !== "stale") return result;

    consumeOrganizationCasStale(budget, options.phase);
  }

  throw busyError(budget, options.phase);
}
