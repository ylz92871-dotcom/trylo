import type { ToolBoardCommandDraft } from "../../../../../tooling/contract/types.js";

export type BoardCommandPort = {
  readonly submit: (command: ToolBoardCommandDraft) => void;
  readonly snapshot: () => readonly ToolBoardCommandDraft[];
};

export function createRecordingBoardPort(): BoardCommandPort {
  const commands: ToolBoardCommandDraft[] = [];
  return {
    submit(command) {
      commands.push(command);
    },
    snapshot() {
      return [...commands];
    },
  };
}

export function boardPortCanActivate(_port: BoardCommandPort): boolean {
  return false;
}
