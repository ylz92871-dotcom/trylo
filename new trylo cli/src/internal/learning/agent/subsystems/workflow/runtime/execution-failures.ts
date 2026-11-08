import type { WorkflowTrace } from "../domain/trace-contracts.js";
import { contentHashOf } from "../../../../control/hash.js";

const SECRET_COMMAND = /(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]|-----BEGIN .*PRIVATE KEY|\b(?:sk|ghp)-[A-Za-z0-9])/i;

/** Failed receipts survive checkpoint freshness boundaries; they never infer nodes. */
export function createWorkflowFailureReceipts(checkCommands: readonly string[]) {
  const requiredChecks = new Set(checkCommands.map(command => contentHashOf(command)));
  const failures = new Map<string, { readonly receipt: NonNullable<WorkflowTrace["otherFailures"]>[number]; readonly commandHash: string; recovered: boolean }>();

  return {
    observe(toolCallId: string, command: string, status: "passed" | "failed", evidenceRef: string): boolean {
      const commandHash = contentHashOf(command);

      if (status === "passed") {
        for (const failure of failures.values()) if (failure.commandHash === commandHash) failure.recovered = true;
      } else if (!failures.has(evidenceRef)) {
        if (failures.size >= 128) return false;
        failures.set(evidenceRef, { commandHash, recovered: false, receipt: { toolCallId, evidenceRef,
          command: command.length > 4096 || SECRET_COMMAND.test(command) ? `[redacted shell command sha256:${commandHash}]` : command } });
      }

      return true;
    },
    snapshot(recordedRefs: ReadonlySet<string>) {
      const remaining = [...failures.values()].filter(item => !recordedRefs.has(item.receipt.evidenceRef));
      return { otherFailures: remaining.map(item => item.receipt),
        unrecovered: remaining.some(item => requiredChecks.has(item.commandHash) && !item.recovered) };
    },
  };
}
