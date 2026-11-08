import type { CentralAccountingOwner, CentralAccountingReservation } from "../../learning/control/central-accounting-contract.js";
import { isCentralAccountingOwner, sameCentralAccountingOwner } from "../../learning/control/central-accounting-parse.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { centralBudgetReference } from "../../learning/control/central-budget-parse.js";
import type { CentralAccountingAction } from "../../learning/control/central-accounting-contract.js";
import type { CentralLearningUsage } from "../../learning/control/coordination-contract.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";

type Failure = { readonly ok: false; readonly reason: string };

type Receipt = { readonly ok: true; readonly projection: CentralBudgetProjection; readonly reservation: CentralAccountingReservation;
  readonly status: "reserved" | "settled" | "duplicate" };

type ReservationInput = { readonly reservationId: string; readonly maxTokens: number;
  /** Preserve the prefix at which the peer checked its source/operation envelope. */
  readonly expectedSequence?: number };

export interface CentralAccountingFundingPort {
  inspect(): Promise<Failure | { readonly ok: true; readonly projection: CentralBudgetProjection; readonly boardSequence: number;
    /** Captured capability owner; absence of a reservation alone cannot identify the requesting peer. */
    readonly owner: CentralAccountingOwner }>;
  /** Only status=reserved permits one dispatch. duplicate is a durable receipt, never a new dispatch right. */
  reserve(input: ReservationInput): Promise<Failure | Receipt>;
  settle(input: { readonly reservationId: string; readonly usage: CentralLearningUsage }): Promise<Failure | Receipt>;
}

export interface CentralAccountingFundingOptions {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly budgetId: string; readonly scope: string; readonly owner: CentralAccountingOwner;
  readonly now: () => string; readonly enabled: () => boolean;
}

const failed = (reason: string): Failure => ({ ok: false, reason });

/** The original root and final writer gate are shared with worker allocation. This creates no wallet or Agent grant. */
export function createCentralAccountingFundingAtRoot(options: Omit<CentralAccountingFundingOptions, "board"> & {
  readonly boardRoot: string;
}): CentralAccountingFundingPort {
  const { boardRoot, ...supplied } = options;
  const bound = { ...supplied, owner: Object.freeze({ ...options.owner }) };
  const admitted = (command: BoardCommand) => command.type === "coordinate_learning"
    && (command.action.kind === "settle_budget_usage" || command.action.kind === "reserve_budget_usage" && bound.enabled());
  const port = createCentralAccountingFunding({ ...bound, board: {
    load: () => createBoardReader(boardRoot).load(),
    apply: command => withBoardWriter(boardRoot, store => store.apply(command), {
      commandGuard: admitted, admission: { canEnter: () => admitted(command) },
    }),
  } });

  return Object.freeze({ ...port,
    reserve: (input: ReservationInput) => input.expectedSequence !== undefined ? port.reserve(input)
      // Without a caller-owned source fence, choose the physical prefix only
      // after writer admission. PA appends cannot invalidate it before reserve.
      : withBoardWriter(boardRoot, store => createCentralAccountingFunding({ ...bound, board: store }).reserve(input), {
        commandGuard: admitted, admission: { canEnter: bound.enabled },
      }),
  });
}

/** Capability to one authorized root and peer owner. It cannot open, replenish or allocate a budget. */
export function createCentralAccountingFunding(options: CentralAccountingFundingOptions): CentralAccountingFundingPort {
  if (!centralBudgetReference(options.budgetId) || !coordinationScopeValid(options.scope) || !isCentralAccountingOwner(options.owner)) {
    throw new Error("central_accounting_identity_invalid");
  }

  const owner = Object.freeze({ ...options.owner });

  async function load() {
    try {
      const loaded = await options.board.load();
      if (!loaded.ok) return loaded;
      const projection = centralBudgetProjection(loaded.state, options.budgetId);
      return projection?.budget.scope === options.scope ? { ok: true as const, projection, boardSequence: loaded.state.sequence }
        : failed("central_accounting_budget_mismatch");
    } catch { return failed("board_unavailable"); }
  }

  async function send(action: Exclude<CentralAccountingAction, { readonly kind: "set_budget_limit" }>): Promise<Failure | Receipt> {
    try {
      const result = await options.board.apply({ type: "coordinate_learning", issuedAt: options.now(), action,
        commandId: `central-accounting:${contentHashOf(action)}` });
      if (!result.ok) return result;

      const projection = centralBudgetProjection(result.state, options.budgetId);
      const reservation = projection?.budget.accounting?.find(item => item.reservationId === action.reservationId);
      if (projection?.budget.scope !== options.scope || reservation === undefined || !sameCentralAccountingOwner(reservation.owner, owner)) {
        return failed("central_accounting_reservation_mismatch");
      }

      return { ok: true, projection, reservation, status: result.idempotent ? "duplicate"
        : action.kind === "reserve_budget_usage" ? "reserved" : "settled" };
    } catch { return failed("board_unavailable"); }
  }

  return Object.freeze({
    async inspect() {
      if (!options.enabled()) return failed("collect_disabled");
      const result = await load();
      if (!options.enabled()) return failed("collect_disabled");
      return result.ok ? { ...result, owner } : result;
    },

    async reserve(input: ReservationInput) {
      if (!options.enabled()) return failed("collect_disabled");

      const loaded = await load();
      if (!loaded.ok) return loaded;

      if (!options.enabled()) return failed("collect_disabled");

      return send({ kind: "reserve_budget_usage", budgetId: options.budgetId, scope: options.scope, owner,
        reservationId: input.reservationId, maxTokens: input.maxTokens,
        expectedSequence: input.expectedSequence ?? loaded.boardSequence });
    },

    async settle(input: { readonly reservationId: string; readonly usage: CentralLearningUsage }) {
      // Disable, cancellation and a lost model context never erase the original request's bill.
      return send({ kind: "settle_budget_usage", budgetId: options.budgetId, scope: options.scope, owner,
        reservationId: input.reservationId, usage: input.usage });
    },
  });
}
