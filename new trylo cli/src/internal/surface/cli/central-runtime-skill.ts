import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createCentralSkillExecution } from "../../integration/central-learning/skill-adapter.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { CliContext } from "./context.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import type { SkillDailyConnection } from "./skill-daily-provider.js";

export type CentralRuntimeSkillOptions = {
  readonly ctx: CliContext;
  readonly boardRoot: string;
  readonly scope: string;
  readonly provider: ProviderPort;
  /** Actual bootstrap connection matching the injected review transport. */
  readonly connection: SkillDailyConnection;
  readonly maxOutputTokens?: number;
  readonly contextForIssue?: CentralLearningContextReader;
  readonly enabled: () => boolean;
};

export type CentralRuntimeSkill = {
  readonly port: CentralLearningExecutionPort;
  close(): Promise<void>;
};

/** Hermes owns its original source reader, permissions, review process and
 * managed funding. Its lifecycle belongs to this scope owner, not a turn. */
export function createCentralRuntimeSkill(options: CentralRuntimeSkillOptions): CentralRuntimeSkill {
  let open = true;
  const enabled = () => open && options.enabled();
  const runtime = createHermesSkillRuntime({ ...options.ctx, cwd: options.scope }, undefined, {
    boardRoot: options.boardRoot, provider: options.provider, connection: options.connection, enabled,
    ...(options.maxOutputTokens === undefined ? {} : { generationMaxOutputTokens: options.maxOutputTokens }),
    ...(options.contextForIssue === undefined ? {} : { contextForIssue: options.contextForIssue }),
  });
  const execution = createCentralSkillExecution({ board: createBoardReader(options.boardRoot), boardRoot: options.boardRoot, scope: options.scope, runtime });
  const port: CentralLearningExecutionPort = { ...execution,
    prepare: (input, signal) => enabled() ? execution.prepare(input, signal)
      : Promise.resolve({ status: "unavailable", reason: "collect_disabled", sourceRefs: [] }),
    dispatch: (input, signal) => enabled() ? execution.dispatch(input, signal)
      : Promise.resolve({ ok: false, reason: "collect_disabled" }),
  };

  return { port, async close() {
    open = false;
    await runtime.close();
  } };
}
