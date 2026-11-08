import { createToolCandidateExecutor } from "../../../../../../adapters/tool-evolution/process-executor.js";
import { createWindowsIsolation } from "../../../../../../adapters/sandbox/windows-isolation.js";
import { windowsHelperEnvironment } from "../../../../../../adapters/sandbox/windows-helper-environment.js";
import { hostNodeExecutable } from "../../../../../../adapters/sandbox/executable.js";
import { permissionPattern } from "../../../../../../ports/permission.js";
import { type PermissionPort } from "../../../../../../ports/permission.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { type CandidateExecution, type CandidateExecutor } from "../../../../../domains/tool/evolution/execution.js";

export function createApprovedCheckerExecutor(host: { readonly permission: PermissionPort; readonly scratchRoot: string;
  readonly env: Readonly<Record<string, string | undefined>> }): CandidateExecutor {
  const executor = createToolCandidateExecutor({ isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(host.env) }),
    scratchRoot: host.scratchRoot, nodeExecutable: hostNodeExecutable(),
    profile: "confined_json_function_v1", timeoutMs: 5000 });
  const approved: CandidateExecutor = {
    async execute(candidate, facts, signal) {
      return boundedCheckExecution(async checkSignal => {
        if (checkSignal.aborted) return { kind: "cancelled" };

        const args = { command: `Execute confined learned check ${candidate.identity}`, candidateHash: contentHashOf(candidate), source: candidate.source };
        const ticket = await host.permission.request({ toolCallId: `checker:${contentHashOf([candidate, facts])}`, name: "run_shell",
          arguments: args, pattern: permissionPattern("run_shell", args) }, { signal: checkSignal });
        const decision = await host.permission.awaitDecision(ticket.ticketId, { signal: checkSignal });

        if (checkSignal.aborted) return { kind: "cancelled" };

        if (decision.resolution !== "approved") return { kind: "unavailable", detail: "checker_execution_permission_denied" };

        return executor.execute(candidate, facts, checkSignal);
      }, signal);
    },
  };

  return approved;
}

async function boundedCheckExecution(execute: (signal: AbortSignal) => Promise<CandidateExecution>, signal: AbortSignal): Promise<CandidateExecution> {
  const controller = new AbortController();
  const cancel = () => controller.abort();

  signal.addEventListener("abort", cancel, { once: true });

  if (signal.aborted) controller.abort();

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([execute(controller.signal), new Promise<CandidateExecution>(resolve => {
      // Native ACL and helper preparation have their own OS-operation bounds and can exceed the 5s program limit.
      // This is an overall soft deadline: synchronous platform operations finish before JS can observe cancellation.
      timer = setTimeout(() => { controller.abort();
      resolve(signal.aborted ? { kind: "cancelled" }
        : { kind: "timeout", detail: "checker approval, preparation or execution exceeded its soft deadline" }); }, 60000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    signal.removeEventListener("abort", cancel);
  }
}
