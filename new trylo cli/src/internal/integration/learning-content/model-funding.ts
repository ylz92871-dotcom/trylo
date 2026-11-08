import type { CentralFundingPort, ControlResult } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { CentralLearningAgentDomain, CentralLearningGrant, CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralLearningRemaining } from "../../learning/control/coordination-contract.js";
import { coordinationForJob } from "../../learning/control/coordination-state.js";
import { coordinationScopeValid } from "../../learning/control/coordination-parse.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { text } from "../../validation/json-shape.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";

export interface ContentGrantFundingOptions {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly scope: string;
  readonly domain: CentralLearningAgentDomain;
  readonly grantId: string;
  readonly claimId: string;
  readonly now: () => string;
  readonly enabled: () => boolean;
}

type Loaded = ControlResult<{ readonly state: BoardState; readonly grant: CentralLearningGrant }>;

const failed = (reason: string) => ({ ok: false as const, reason });

/** Original worker composition: the same Board lock/reducer/log, with a final durable
 * gate after asynchronous reads. Settlement remains allowed when collection is disabled. */
export function createContentGrantFundingAtRoot(options: Omit<ContentGrantFundingOptions, "board"> & { readonly boardRoot: string }): CentralFundingPort {
  const { boardRoot, ...bound } = options;
  return createContentGrantFunding({ ...bound, board: {
    load: () => createBoardReader(boardRoot).load(),

    apply: command => {
      const admitted = (current: typeof command) => current.type === "coordinate_learning"
        && (current.action.kind === "settle" || current.action.kind === "reserve" && options.enabled());
      return withBoardWriter(boardRoot, store => store.apply(command), {
        commandGuard: admitted, admission: { canEnter: () => admitted(command) },
      });
    },
  } });
}

/** A capability to an existing claim only. All state, limits, admission and final spend
 * remain in the canonical Board reducer. This port cannot claim, fund, renew or reopen. */
export function createContentGrantFunding(options: ContentGrantFundingOptions): CentralFundingPort {
  if (!coordinationScopeValid(options.scope) || ![options.grantId, options.claimId].every(value => text(value, 512))) {
    throw new Error("content_funding_identity_invalid");
  }

  const boundGrant = (state: BoardState) => state.centralLearningGrants?.find(grant => grant.grantId === options.grantId
    && grant.scope === options.scope && (grant.domain ?? "collaboration") === options.domain);

  async function load(): Promise<Loaded> {
    try {
      const loaded = await options.board.load();
      if (!loaded.ok) return loaded;
      const grant = boundGrant(loaded.state);
      return grant === undefined ? failed("content_funding_grant_mismatch") : { ok: true, state: loaded.state, grant };
    } catch { return failed("board_unavailable"); }
  }

  async function send(action: Extract<CoordinationAction, { readonly kind: "reserve" | "settle" }>) {
    try {
      const result = await options.board.apply({ type: "coordinate_learning", issuedAt: options.now(), action,
        commandId: `content-accounting:${contentHashOf(action)}` });
      if (!result.ok) return result;
      const grant = boundGrant(result.state);
      return grant === undefined ? failed("content_funding_grant_mismatch") : { ok: true as const, grant,
        duplicate: result.idempotent, remaining: centralLearningRemaining(grant) };
    } catch { return failed("board_unavailable"); }
  }

  return Object.freeze({
    async inspect() {
      if (!options.enabled()) return failed("collect_disabled");

      const loaded = await load();
      if (!loaded.ok) return loaded;

      if (!options.enabled()) return failed("collect_disabled");

      const current = coordinationForJob(loaded.state, loaded.grant.jobId), grant = loaded.grant;

      return { ok: true as const, grant, remaining: centralLearningRemaining(grant), active: grant.status === "open"
        && current?.issue.decision.kind === "focused_learning" && current.job.state === "running"
        && grant.claim?.claimId === options.claimId && Date.parse(grant.claim.expiresAt) > Date.parse(options.now()) };
    },

    async reserve(input) {
      if (!options.enabled()) return failed("collect_disabled");

      // The reducer rechecks the actual claim, focus, lease and all three resource caps atomically.
      const loaded = await load();
      if (!loaded.ok) return loaded;

      if (!options.enabled()) return failed("collect_disabled");

      const result = await send({ kind: "reserve", grantId: options.grantId, claimId: options.claimId,
        reservationId: input.reservationId, maxTokens: input.maxTokens });
      if (!result.ok) return result;

      return { ...result, status: result.duplicate ? "duplicate" as const : "reserved" as const };
    },

    async settle(input) {
      // Collection disable/claim expiry cannot erase an already dispatched request's bill.
      const loaded = await load();
      if (!loaded.ok) return loaded;

      const original = loaded.grant.reservations.find(row => row.reservationId === input.reservationId);
      if (original?.claimId !== options.claimId) return failed("content_funding_reservation_mismatch");

      const result = await send({ kind: "settle", grantId: options.grantId, reservationId: input.reservationId, usage: input.usage });
      if (!result.ok) return result;

      return { ...result, status: result.duplicate ? "duplicate" as const : "settled" as const };
    },
  });
}
