import type { CliContext } from "./context.js";
import type { HermesSkillGrant } from "../../learning/agent/subsystems/skill/index.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";

/** A thin controller/tool-style entry: name + allowance; context stays in the runtime. */
export async function handleHermesSkillLearn(ctx: CliContext, options: { readonly grant: HermesSkillGrant }): Promise<ExitCode> {
  const cancellation = observeRunCancellation(ctx), runtime = createHermesSkillRuntime(ctx);
  try {
    const result = await runtime.learn(options.grant, cancellation.signal);
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, subsystem: "skill", ...result })}\n`);
    return result.status === "cancelled" ? EXIT_CODES.CANCELLED : result.status === "failed" ? EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.OK;
  } catch {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, subsystem: "skill", status: "failed", reason: "hermes_skill_runtime_unavailable" })}\n`);
    return EXIT_CODES.CONFIG;
  } finally {
    cancellation.close();
    runtime.close();
  }
}
