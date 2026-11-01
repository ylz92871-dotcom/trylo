import path from "node:path";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { permissionFor } from "./permission-for-run.js";
import { permissionPattern } from "../../ports/permission.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import { createToolEvolutionVerifier } from "../../adapters/tool-evolution/process-verifier.js";
import { createWindowsIsolation } from "../../adapters/sandbox/windows-isolation.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";
import { windowsHelperEnvironment } from "../../adapters/sandbox/windows-helper-environment.js";
import { tryloHome } from "./session-paths.js";

/** One approval composition for generation checks and later frozen-version trials. */
export function toolEvolutionExecution(ctx: CliContext, run: RunCommandOptions, mode: "manual" | "after_turn" = "manual") {
  const permission = permissionFor(mode === "manual" && ctx.stdinIsTty ? "interactive" : "non_interactive", ctx, run);
  const verifier: ToolEvolutionVerifier = {
    async verify(candidate, request, signal) {
      const candidateHash = sha256Hex(canonicalJson(candidate));
      const samplesHash = sha256Hex(canonicalJson(request.evidence));
      if (signal.aborted) return { verdict: "cancelled", candidateHash, samplesHash, checks: [] };
      ctx.stderr(`Tool candidate ${candidate.identity} (${candidateHash})\n${candidate.source}\n`);
      const args = { candidateHash, requestId: request.requestId, scope: request.scope };
      const ticket = await permission.request({ toolCallId: ctx.newId("tool-evolution-check"), name: "run_shell", arguments: args,
        pattern: permissionPattern("run_shell", args) }, { signal });
      const answer = await permission.awaitDecision(ticket.ticketId, { signal });
      if (signal.aborted || answer.resolution !== "approved") return {
        verdict: signal.aborted || answer.resolution === "cancelled" ? "cancelled" : "unavailable", candidateHash, samplesHash, checks: [],
      };
      return createToolEvolutionVerifier({ isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(ctx.env) }),
        scratchRoot: path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "tool", "quarantine"), nodeExecutable: hostNodeExecutable() }).verify(candidate, request, signal);
    },
  };
  return { permission, verifier };
}
