import { createUserMemoryService } from "../../integration/user-learning/memory-service.js";
import { createFileFactStore } from "../../integration/user-learning/facts-file.js";
import { decideScopeV2 } from "../../learning/domains/user/scope-v2.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { userLearningRoot } from "./user-learning-config.js";
import { workspaceIdentity } from "./wiring-catalog.js";

/** An explicit management command; personal text travels over stdin, never argv. */
export async function handleMemoryMutation(ctx: CliContext, action: "correct" | "retract"): Promise<ExitCode> {
  let value: unknown;

  try { value = JSON.parse(await ctx.readStdin()); }
  catch {
    ctx.stderr("memory: invalid JSON request\n");
    return EXIT_CODES.USAGE;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return EXIT_CODES.USAGE;

  const item = value as Record<string, unknown>;
  const recordId = item["recordId"], expectedVersion = item["expectedVersion"], commandId = item["commandId"], statement = item["statement"];
  if (typeof recordId !== "string" || recordId.length === 0 || typeof commandId !== "string" || commandId.length === 0
    || commandId.length > 200 || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || (action === "correct" && (typeof statement !== "string" || statement.trim().length === 0 || statement.length > 8_192))) return EXIT_CODES.USAGE;

  const workspaceId = workspaceIdentity(ctx.cwd);
  const service = createUserMemoryService({
    store: createFileFactStore(userLearningRoot(ctx.homeDir, ctx.env)),
    userId: decideScopeV2({ workspaceId }).identity.userId, workspaceId, now: ctx.now, switchValue: "user",
    turn: { sessionId: "memory-management", turnId: commandId, userEventId: `memory-management:${commandId}`,
      managementAction: action,
      userText: typeof statement === "string" ? statement : "撤回这条记忆" },
  });
  const request = { recordId, expectedVersion, commandId };
  const result = action === "correct" && typeof statement === "string" ? service.correct({ ...request, statement }) : service.retract(request);

  ctx.stdout(`${JSON.stringify(result)}\n`);

  return result.result === "saved" || result.result === "already_saved" ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
}
