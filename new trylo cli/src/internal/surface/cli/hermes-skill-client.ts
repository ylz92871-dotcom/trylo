import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesNodeClient } from "../../learning/agent/subsystems/skill/host/index.js";
import { hostShellEnvironment } from "../../adapters/sandbox/executable.js";
import type { CliContext } from "./context.js";

/** One CLI-owned location formula for normal consumption and the learner. */
export function createCliHermesClient(ctx: Pick<CliContext, "env" | "homeDir" | "nodeExecutable" | "newId" | "platform">) {
  const platform = ctx.platform ?? hostShellEnvironment().platform;
  const storageBase = platform === "darwin" ? path.join(ctx.homeDir, "Library", "Application Support") : ctx.env.APPDATA ?? ctx.homeDir;
  return createHermesNodeClient({ nodeBinary: ctx.env.TRYLO_NODE_BINARY ?? ctx.nodeExecutable ?? "node", env: ctx.env,
    storageRoot: ctx.env.TRYLO_HERMES_STORAGE_ROOT ?? path.join(storageBase, "me.trylocode.trylo", "Trylo"),
    nextId: () => ctx.newId("hermes-request") });
}

export const hermesCapabilitiesDirectory = fileURLToPath(new URL("../../learning/agent/subsystems/skill/vendor/legacy/hermes-capabilities/", import.meta.url));
