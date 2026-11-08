import { shortId } from "./hash.js";
import type { AssetKind } from "./types.js";

export const BOARD_COMMAND_KINDS = [
  "submit_draft",
  "submit_evidence",
  "submit_withdraw",
] as const;

export type BoardCommandKind = (typeof BOARD_COMMAND_KINDS)[number];

export type BoardCommandDraft = {
  readonly commandId: string;
  readonly kind: BoardCommandKind;
  readonly assetKind: AssetKind;
  readonly payloadId: string;
};

export const FORBIDDEN_BOARD_ACTIONS = [
  "activate",
  "setActive",
  "writeBoardState",
  "setActivePointer",
] as const;

export function submitDraftCommand(
  assetKind: AssetKind,
  payloadId: string,
): BoardCommandDraft {
  return {
    commandId: shortId("cmd", [assetKind, "submit_draft", payloadId]),
    kind: "submit_draft",
    assetKind,
    payloadId,
  };
}

export function submitWithdrawCommand(
  assetKind: AssetKind,
  payloadId: string,
): BoardCommandDraft {
  return {
    commandId: shortId("cmd", [assetKind, "submit_withdraw", payloadId]),
    kind: "submit_withdraw",
    assetKind,
    payloadId,
  };
}

export function submitEvidenceCommand(
  assetKind: AssetKind,
  payloadId: string,
): BoardCommandDraft {
  return {
    commandId: shortId("cmd", [assetKind, "submit_evidence", payloadId]),
    kind: "submit_evidence",
    assetKind,
    payloadId,
  };
}

export function assertNoActivation(value: object): void {
  const keys = Object.keys(value);
  for (const action of FORBIDDEN_BOARD_ACTIONS) {
    if (keys.includes(action)) {
      throw new Error(`forbidden board action present: ${action}`);
    }
  }
}
