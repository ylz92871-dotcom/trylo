import type { ToolBoardCommandDraft } from "../../../../../../tooling/contract/types.js";

export type MyToolsButton = "suspend" | "rollback" | "prepare_contribution" | "activate";

export type ButtonPress = {
  readonly mutated: false;
  readonly command: ToolBoardCommandDraft;
};

export function pressMyToolsButton(
  button: MyToolsButton,
  packageVersionId: string,
): ButtonPress {
  if (button === "suspend") {
    return {
      mutated: false,
      command: { kind: "request_suspend", packageVersionId, reason: "user suspend" },
    };
  }

  if (button === "rollback") {
    return {
      mutated: false,
      command: { kind: "request_rollback", packageVersionId, reason: "user rollback" },
    };
  }

  if (button === "activate") {
    return {
      mutated: false,
      command: {
        kind: "submit_evidence",
        evidenceId: `activate:${packageVersionId}`,
        summary: "activation requested; Board remains the only active writer",
      },
    };
  }

  return {
    mutated: false,
    command: {
      kind: "submit_evidence",
      evidenceId: `contribute:${packageVersionId}`,
      summary: "prepare local contribution bundle",
    },
  };
}
