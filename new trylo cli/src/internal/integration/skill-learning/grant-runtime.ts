import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { LearningGrantDraft, LearningGrantReservation, LearningGrantSnapshot, LearningGrantUsage } from "../../learning/control/grant-contract.js";
import { isLearningGrantDraft, isLearningGrantUsage } from "../../learning/control/grant-parse.js";
import { learningGrantSnapshots } from "../../learning/control/grant-state.js";
import type { BoardStore } from "../../learning/control/store-port.js";

export type SkillGrantFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type SkillGrantResult<T> = ({ readonly ok: true; readonly snapshot: LearningGrantSnapshot } & T) | SkillGrantFailure;

export type SkillGrantOpen = { readonly grantId: string; readonly sourceRef: string; readonly maxCalls: number; readonly maxOutputTokens: number };

export type SkillGrantReserve = { readonly grantId: string; readonly reservationId: string; readonly maxOutputTokens?: number };

export type SkillGrantReservationResult = SkillGrantResult<{ readonly status: "reserved" | "duplicate"; readonly reservation: LearningGrantReservation }>;

export class SkillLearningGrantError extends Error { constructor(readonly code: string) { super(code); } }

/** One budget writer over the canonical Board; no local allowance ledger. */
export function createSkillLearningGrant(options: { readonly board: BoardStore; readonly workspaceId: string; readonly now: () => string }) {
  let phase: "idle" | "writing" = "idle";
  const read = async (grantId: string): Promise<SkillGrantResult<Record<never, never>>> => {
    try {
      const loaded = await options.board.load();
      if (!loaded.ok) return failure(loaded.reason);

      const snapshots = learningGrantSnapshots(loaded.state.learningGrantFacts ?? []);
      if (snapshots === undefined) return failure("invalid_learning_grant");

      const snapshot = snapshots.get(grantId);
      if (snapshot === undefined) return failure("learning_grant_not_found");

      return snapshot.workspaceId === options.workspaceId ? { ok: true, snapshot } : failure("learning_grant_scope_mismatch");
    } catch { return failure("board_unavailable"); }
  };
  const write = async (fact: LearningGrantDraft): Promise<SkillGrantResult<{ readonly writeStatus: "new" | "duplicate" }>> => {
    const coordinate = fact.kind === "reserve" || fact.kind === "settle" ? fact.reservationId : fact.kind;
    const result = await options.board.apply({ type: "record_learning_grant_fact", fact,
      commandId: `learning-grant:${contentHashOf([fact.grantId, fact.kind, coordinate])}`, issuedAt: options.now() });
    if (!result.ok) return failure(result.reason);
    const loaded = await read(fact.grantId);
    return loaded.ok ? { ...loaded, writeStatus: result.idempotent ? "duplicate" : "new" } : loaded;
  };
  const mutate = async <T>(run: () => Promise<SkillGrantResult<T>>): Promise<SkillGrantResult<T>> => {
    if (phase !== "idle") return failure("learning_grant_unsettled");
    phase = "writing";
    try { return await run(); }
    catch { return failure("board_unavailable"); }
    finally { phase = "idle"; }
  };

  return {
    read,

    open(input: SkillGrantOpen): Promise<SkillGrantResult<{ readonly status: "opened" | "existing" }>> {
      return mutate(async () => {
        const fact: LearningGrantDraft = { schemaVersion: 1, kind: "open", grantId: input.grantId, subsystem: "skill",
          workspaceId: options.workspaceId, sourceRef: input.sourceRef, allowance: { maxCalls: input.maxCalls, maxOutputTokens: input.maxOutputTokens } };
        if (!isLearningGrantDraft(fact)) return failure("invalid_learning_grant");

        const previous = await read(input.grantId);
        if (previous.ok) return previous.snapshot.sourceRef === fact.sourceRef && canonicalJson(previous.snapshot.allowance) === canonicalJson(fact.allowance)
          ? { ...previous, status: "existing" } : failure("learning_grant_conflict");

        if (previous.code !== "learning_grant_not_found") return previous;

        const result = await write(fact);

        return result.ok ? { ...result, status: "opened" } : result;
      });
    },

    reserve(input: SkillGrantReserve): Promise<SkillGrantReservationResult> {
      return mutate(async () => {
        const current = await read(input.grantId);
        if (!current.ok) return current;

        const duplicate = current.snapshot.reservations.find(item => item.reservationId === input.reservationId);
        if (duplicate !== undefined) return { ...current, status: "duplicate", reservation: duplicate };

        const remaining = current.snapshot.allowance.maxOutputTokens - current.snapshot.reportedOutputTokens;
        const cap = input.maxOutputTokens === undefined ? remaining : Math.min(input.maxOutputTokens, remaining);
        if (cap <= 0) return failure("learning_grant_exhausted");

        const fact: LearningGrantDraft = { schemaVersion: 1, kind: "reserve", grantId: input.grantId, reservationId: input.reservationId, maxOutputTokens: cap };
        if (!isLearningGrantDraft(fact)) return failure("invalid_learning_grant");

        const result = await write(fact);
        if (!result.ok) return result;

        const reservation = result.snapshot.reservations.find(item => item.reservationId === input.reservationId);

        return reservation === undefined ? failure("invalid_learning_grant") : { ...result, status: result.writeStatus === "duplicate" ? "duplicate" : "reserved", reservation };
      });
    },

    settle(input: { readonly grantId: string; readonly reservationId: string; readonly usage: LearningGrantUsage }): Promise<SkillGrantResult<{ readonly status: "settled" | "duplicate" }>> {
      return mutate(async () => {
        if (!isLearningGrantUsage(input.usage)) return failure("invalid_learning_grant");

        const current = await read(input.grantId);
        if (!current.ok) return current;

        const reservation = current.snapshot.reservations.find(item => item.reservationId === input.reservationId);
        if (reservation !== undefined && reservation.state !== "reserved") return canonicalJson(reservation.usage) === canonicalJson(input.usage)
          ? { ...current, status: "duplicate" } : failure("learning_grant_conflict");

        const result = await write({ schemaVersion: 1, kind: "settle", grantId: input.grantId, reservationId: input.reservationId, usage: input.usage });

        return result.ok ? { ...result, status: "settled" } : result;
      });
    },

    close(input: { readonly grantId: string; readonly reason: Extract<LearningGrantDraft, { kind: "close" }>["reason"] }): Promise<SkillGrantResult<{ readonly status: "closed" | "duplicate" }>> {
      return mutate(async () => {
        const current = await read(input.grantId);
        if (!current.ok) return current;
        if (current.snapshot.closedReason !== undefined) return current.snapshot.closedReason === input.reason
          ? { ...current, status: "duplicate" } : failure("learning_grant_conflict");
        const result = await write({ schemaVersion: 1, kind: "close", grantId: input.grantId, reason: input.reason });
        return result.ok ? { ...result, status: "closed" } : result;
      });
    },
  };
}

function failure(code: string): SkillGrantFailure { return { ok: false, code, message: code }; }
