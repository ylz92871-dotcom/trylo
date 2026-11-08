import { resolve } from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { AgentLearningReadReply } from "../../protocol/agent-learning-read.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { readAgentLearningDocuments } from "./agent-learning-read-model.js";
import type { AgentLearningReadOptions } from "./args-agent-learning-read.js";
import type { CliContext } from "./context.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";

/** Reads one Board snapshot, never composes a model, task, tool or writer. */
export async function handleAgentLearningRead(ctx: CliContext, options: AgentLearningReadOptions): Promise<ExitCode> {
  const write = (value: AgentLearningReadReply): ExitCode => {
    ctx.stdout(`${JSON.stringify(value)}\n`);
    return value.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  };
  const loaded = await createBoardReader(workflowBoardRoot(ctx)).load();
  if (!loaded.ok) return write({ schemaVersion: 1, ok: false, reason: loaded.reason });

  const result = readAgentLearningDocuments(loaded.state, options.subsystem, resolve(ctx.cwd), workspaceIdentity(ctx.cwd));
  if (!result.ok) return write({ schemaVersion: 1, ok: false, reason: result.reason });

  const entries = options.versionId === undefined ? result.entries : result.entries.filter(item => item.versionId === options.versionId);
  if (options.versionId !== undefined && entries.length !== 1) return write({ schemaVersion: 1, ok: false, reason: "learning_version_not_found" });

  return write({ schemaVersion: 1, ok: true, domain: options.subsystem, entries });
}
