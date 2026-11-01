import path from "node:path";
import { createFileVerificationRegistry } from "../../internal/adapters/verification-authority-store/index.js";
import { verifyToolProductionPlan } from "../../internal/adapters/tool-evolution/production-verifier.js";
import { createWindowsIsolation } from "../../internal/adapters/sandbox/windows-isolation.js";
import { hostNodeExecutable } from "../../internal/adapters/sandbox/executable.js";
import { windowsHelperEnvironment } from "../../internal/adapters/sandbox/windows-helper-environment.js";
import { createBoardReader } from "../../internal/adapters/learning-store/file-event-store.js";
import { productionProposalId, toolProductionGenerator, toolProductionVerifier } from "../../internal/integration/tool-learning/production-assets.js";
import { contentHashOf } from "../../internal/learning/control/hash.js";
import { toolProductionScope, toolProductionVersion } from "../../internal/learning/domains/tool/evolution/production-plan.js";
import type { ToolProductionPort } from "../../internal/ports/tool-production.js";
import { tryloHome } from "../../internal/surface/cli/session-paths.js";
import type { CliContext } from "../../internal/surface/cli/context.js";
import { executeNpmTool } from "../../internal/adapters/tool-acquisition/npm-runtime.js";
import { verifyNpmToolProduction } from "../../internal/adapters/tool-acquisition/npm-production-verifier.js";
import { hostNpmTarget } from "../../internal/adapters/tool-acquisition/npm-platform.js";
import { createToolCandidateExecutor } from "../../internal/adapters/tool-evolution/process-executor.js";
import { inspectInstalledNpmMcp } from "../../internal/adapters/tool-acquisition/npm-inspection.js";

/** This is the actual process composition root, outside all internal command/learning layers. */
export function createToolProductionService(facts: Pick<CliContext, "homeDir" | "env" | "now" | "newId">): ToolProductionPort {
  const home = tryloHome(facts.homeDir, facts.env);
  const registry = createFileVerificationRegistry({ path: path.join(home, "learning", "verification", "tool-production.ndjson"),
    clock: () => new Date(facts.now()).toISOString(), idFactory: domain => facts.newId(`tool-production-receipt-${domain}`) });
  const runtime = () => ({ isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(facts.env) }), scratchRoot: path.join(home, "learning", "tool", "quarantine"),
    nodeExecutable: hostNodeExecutable(), installationRoot: path.join(home, "learning", "tool", "installations"), target: hostNpmTarget() });
  return { authority: { verify: registry.verify }, inspectInstallation: (plan, bin, protocol, signal) => inspectInstalledNpmMcp(plan, bin, protocol, runtime(), signal),
    execute: (plan, input, signal) => plan.type === "npm_tool_production_package"
    ? executeNpmTool(plan, input, runtime(), signal)
    : createToolCandidateExecutor({ ...runtime(), profile: "confined_json_function_v1", timeoutMs: plan.manifest.timeoutMs }).execute(plan.candidate, input, signal),
  async check(plan, jobId, signal) {
    const checked = plan.type === "npm_tool_production_package" ? await verifyNpmToolProduction(plan, runtime(), signal) : await verifyToolProductionPlan(plan, runtime(), signal);
    if (checked.kind !== "verified" || signal.aborted) return { kind: signal.aborted ? "cancelled" : "failed", record: checked.record };
    const loaded = await createBoardReader(path.join(home, "learning", "board")).load();
    const job = loaded.ok ? loaded.state.jobs.find(item => item.jobId === jobId) : undefined;
    const versionId = toolProductionVersion(plan), scope = toolProductionScope(plan);
    if (job?.state !== "running" || job.attempt !== 1 || job.scope !== scope || job.observationId !== productionProposalId(versionId)
      || !jobId.startsWith(`tool-production-check:v1:${contentHashOf(plan)}:`)) {
      return { kind: "failed", record: checked.record, failure: { code: "production_check_claim_lost", message: "no current check claim exists; receipt was not issued" } };
    }
    if (signal.aborted) return { kind: "cancelled", record: checked.record };
    const issued = await registry.issue({ domain: "agent_method", subject: { subjectKind: "tool_package_version", subjectId: versionId, subjectVersion: versionId, scope },
      verifierId: toolProductionVerifier(plan), generatorId: toolProductionGenerator(plan), issuedAt: new Date(facts.now()).toISOString(), validationRecord: checked.record });
    return issued.ok ? { kind: "verified", record: checked.record, receipt: issued.receipt } : { kind: "failed", record: checked.record, failure: issued };
  } };
}
