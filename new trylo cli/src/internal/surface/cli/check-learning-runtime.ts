import path from "node:path";
import { createExecutableCheckLearning, createCheckerProviderGenerator, createCheckerProcessOwner,
  createApprovedCheckerExecutor as createSubsystemCheckerExecutor, assessDailyCheckInput,
  checkAssessmentCompatibility } from "../../learning/agent/subsystems/check/index.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { CandidateExecutor } from "../../learning/domains/tool/evolution/execution.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring } from "./wiring.js";
import { methodBoardRoot, methodLearningRoot } from "./learning-sink.js";

export { assessDailyCheckInput, checkAssessmentCompatibility };

/** Shared CLI/stdio composition. The generator never receives a permission port or an oracle writer. */
export async function createDailyCheckRuntime(input: TurnHostInput, wiring: Wiring) {
  if (input.learning === undefined) return undefined;

  const host = input.learning;
  const approved = createApprovedCheckerExecutor({ permission: input.permission, homeDir: host.homeDir, env: host.env });

  return createExecutableCheckLearning({ boardRoot: methodBoardRoot(host.homeDir, host.env),
    generator: createCheckerProviderGenerator({ provider: wiring.ports.provider, model: wiring.model }), executor: approved,
    collection: () => input.checkLearning?.collection ?? "enabled", now: input.now, owner: createCheckerProcessOwner(),
    assessCompatibility: checkAssessmentCompatibility });
}

/** Compatibility composition for existing CLI/native-probe callers; execution policy belongs to check. */
export function createApprovedCheckerExecutor(host: { readonly permission: PermissionPort; readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>> }): CandidateExecutor {
  return createSubsystemCheckerExecutor({ permission: host.permission, env: host.env,
    scratchRoot: path.join(methodLearningRoot(host.homeDir, host.env), "check-quarantine") });
}
