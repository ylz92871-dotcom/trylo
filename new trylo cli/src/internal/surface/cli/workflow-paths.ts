import path from "node:path";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";

export function workflowBoardRoot(ctx: CliContext): string {
  return path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "board");
}
