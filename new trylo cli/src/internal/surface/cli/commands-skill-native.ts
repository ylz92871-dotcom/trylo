import { isSkillNativeParameters, skillFailureCode } from "../../learning/agent/subsystems/skill/index.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { HermesSkillNativeOptions } from "./args-hermes-skill.js";
import type { CliContext } from "./context.js";
import { createCliHermesClient } from "./hermes-skill-client.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { observeCentralRuntimeSkillApproval } from "./central-runtime-skill-approval.js";

type Client = Pick<ReturnType<typeof createCliHermesClient>, "compatibility" | "close">;

/** Preserve native pending/hash/snapshot identities and the original body across the CLI transport. */
export async function handleSkillNative(ctx: CliContext, options: HermesSkillNativeOptions,
  createClient: (ctx: CliContext) => Client = createCliHermesClient,
  observeApproval: typeof observeCentralRuntimeSkillApproval = observeCentralRuntimeSkillApproval): Promise<ExitCode> {
  let params: Record<string, unknown>;

  try {
    const raw = await ctx.readStdin();
    if (raw.length > 65_536) throw new Error("invalid_native_params");
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_native_params");
    params = value as Record<string, unknown>;
    if (!isSkillNativeParameters(options.nativeMethod, params)) throw new Error("invalid_native_params");
  } catch {
    ctx.stdout(`${JSON.stringify({ ok: false, reason: "invalid_skill_native_params" })}\n`);
    return EXIT_CODES.USAGE;
  }

  const cancellation = observeRunCancellation(ctx);
  let client: Client | undefined;

  try {
    client = createClient(ctx);
    const body = await client.compatibility(options.nativeMethod, params, { signal: cancellation.signal });

    if (options.nativeMethod === "pendingApply" && params.subsystem === "skills"
      && typeof params.id === "string" && typeof params.expectedHash === "string") {
      try {
        const observed = await observeApproval(ctx, { pendingId: params.id, expectedHash: params.expectedHash,
          reply: body, at: new Date(ctx.now()).toISOString() });
        if (!observed.ok) ctx.stderr("warning: central_runtime_skill_approval_notification_unavailable\n");
      } catch {
        // The native write may already have committed. Preserve its original
        // reply and expose missing observation separately; never re-apply it.
        ctx.stderr("warning: hermes_skill_lifecycle_observation_unavailable\n");
      }
    }

    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, subsystem: "skill", method: options.nativeMethod, body })}\n`);

    return EXIT_CODES.OK;
  } catch (error) {
    ctx.stdout(`${JSON.stringify({ ok: false, reason: skillFailureCode(error, "hermes_skill_native_unavailable") })}\n`);
    return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE;
  } finally {
    cancellation.close();
    client?.close();
  }
}
