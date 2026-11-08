import { randomUUID } from "node:crypto";
import {
  checkApprovalConsumption,
  checkGrantIssuance,
  consumptionErr,
  consumptionOk,
  epochMs,
  isNonEmptyString,
  type ApprovalConsumptionOutcome,
  type ApprovalConsumptionPort,
  type ApprovalConsumptionReceipt,
  type ApprovalConsumptionRequest,
  type GrantIssuanceInput,
  type PermissionGrant,
  type PermissionGrantLookup,
} from "../../ports/approval-consumption.js";
import { deriveGrantId } from "./codec.js";
import { storeIdFromPath } from "./file-ledger.js";

export type MemoryPermissionStore = ApprovalConsumptionPort & {
  readonly issue: (input: GrantIssuanceInput) => Promise<{ readonly ok: true; readonly grant: PermissionGrant }>;
  readonly revoke: (
    grantId: string,
    now: string,
  ) => Promise<
    | { readonly ok: true; readonly grantId: string; readonly status: "revoked" | "consumed" }
    | { readonly ok: false; readonly code: "unknown_grant" | "invalid_now"; readonly message: string }
  >;
  readonly getGrant: (grantId: string) => Promise<PermissionGrantLookup>;
};

type RevokeOutcome =
  | { readonly ok: true; readonly grantId: string; readonly status: "revoked" | "consumed" }
  | { readonly ok: false; readonly code: "unknown_grant" | "invalid_now"; readonly message: string };

/**
 * Mutable in-process state. The container is shared by reference; the grant
 * array is mutated in place and `sequence` counts **ledger events**, not
 * consumed grants (R2 §4.5).
 */
type MemoryStoreState = {
  readonly grants: PermissionGrant[];
  readonly storeId: string;
  sequence: number;
};

/**
 * In-process Permission store. Test/composition only: it holds no durable
 * state and exposes no reset — a fresh instance is the only way to start from
 * an empty store. Its consume path shares the pure checks with the durable
 * adapter, so rejection semantics cannot drift between the two.
 *
 * Store identity is derived from a per-instance synthetic store path, following
 * the same single derivation as the durable store: there is no injection point
 * (external audit R3 §3 P2-3). Two in-process stores therefore never derive the
 * same grant id from the same facts, and no caller can make them collide.
 *
 * P3 fixes from R2 §4.5: `revoke` distinguishes an unusable timestamp
 * (`invalid_now`) from an unknown grant (`unknown_grant`) instead of reporting
 * both as `unknown_grant`, and the receipt sequence is a monotonic ledger
 * counter rather than "number of consumed grants", which used to drift from the
 * file implementation's event sequence.
 *
 * The four port members live at module scope over the shared state (R3 §13.8
 * single-function length discipline, R4 follow-up): the factory itself stays a
 * wiring table, and each member keeps its own rejection semantics readable in
 * isolation. No assertion, failure code or ordering changed in the extraction.
 */
export function createMemoryPermissionStore(): MemoryPermissionStore {
  const state: MemoryStoreState = {
    grants: [],
    storeId: storeIdFromPath(`memory://${randomUUID()}`),
    sequence: 0,
  };
  return {
    consume: (request) => consumeGrant(state, request),
    issue: (input) => issueGrant(state, input),
    revoke: async (grantId, now) => revokeGrant(state, grantId, now),
    getGrant: (grantId) => lookupGrant(state, grantId),
  };
}

async function consumeGrant(
  state: MemoryStoreState,
  request: ApprovalConsumptionRequest,
): Promise<ApprovalConsumptionOutcome> {
  if (request.token === undefined) {
    return consumptionErr("missing_token", "a grant reference is required");
  }

  if (!isNonEmptyString(request.token.grantId)) {
    return consumptionErr("invalid_token", "grant reference must carry a non-empty grantId");
  }

  const grantId = request.token.grantId;
  const index = state.grants.findIndex((item) => item.grantId === grantId);
  const grant = state.grants[index];
  if (grant === undefined) {
    return consumptionErr("unknown_grant", `no grant ${grantId} in this Permission store`);
  }

  const checked = checkApprovalConsumption(grant, request);
  if (!checked.ok) {
    return consumptionErr(checked.code, checked.message);
  }

  state.grants[index] = { ...grant, status: "consumed" };
  state.sequence += 1;
  const receipt: ApprovalConsumptionReceipt = {
    grantId,
    action: request.action,
    candidateId: request.candidateId,
    packageVersionId: request.packageVersionId,
    scope: request.scope,
    consumedAt: request.now,
    sequence: state.sequence,
  };

  return consumptionOk(receipt);
}

async function issueGrant(
  state: MemoryStoreState,
  input: GrantIssuanceInput,
): Promise<{ readonly ok: true; readonly grant: PermissionGrant }> {
  const checked = checkGrantIssuance(input);
  if (!checked.ok) {
    // The memory store is a test/composition fixture: invalid issuance is a
    // programming error in the caller, not a runtime outcome to negotiate.
    throw new Error(`memory store refused grant issuance: ${checked.code} ${checked.message}`);
  }

  const grant: PermissionGrant = {
    ...input,
    grantId: deriveGrantId(input, state.sequence + 1, state.storeId),
    status: "active",
  };

  state.sequence += 1;
  state.grants.push(grant);

  return { ok: true, grant };
}

function revokeGrant(state: MemoryStoreState, grantId: string, now: string): RevokeOutcome {
  const at = epochMs(now);
  if (!isNonEmptyString(grantId) || at === undefined) {
    // R2 §4.5: an unusable timestamp is not "the grant does not exist".
    return at === undefined
      ? { ok: false, code: "invalid_now", message: "revoke needs a strict ISO-8601 timestamp" }
      : { ok: false, code: "unknown_grant", message: "revoke needs a non-empty grantId" };
  }

  const index = state.grants.findIndex((item) => item.grantId === grantId);
  const grant = state.grants[index];
  if (grant === undefined) {
    return { ok: false, code: "unknown_grant", message: `no grant ${grantId}` };
  }

  if (grant.status === "active") {
    state.grants[index] = { ...grant, status: "revoked" };
    state.sequence += 1;
    return { ok: true, grantId, status: "revoked" };
  }

  return { ok: true, grantId, status: grant.status };
}

async function lookupGrant(state: MemoryStoreState, grantId: string): Promise<PermissionGrantLookup> {
  return { ok: true, grant: state.grants.find((item) => item.grantId === grantId) };
}
