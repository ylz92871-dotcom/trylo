import path from "node:path";
import type { CliContext } from "./context.js";
import type { TurnOutcome } from "./host.js";

export function writeLastMessage(ctx: CliContext, target: string | undefined, outcome: TurnOutcome): ReadonlyArray<string> {
  if (target === undefined) return [];
  const absolute = path.resolve(ctx.cwd, target);
  return ctx.writeFile(absolute, outcome.result.lastMessage) ? [] : [`output_last_message_failed:${absolute}`];
}
