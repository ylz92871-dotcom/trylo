import type { Message } from "../../contract/execution.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";
import type { PermissionGrantCache } from "../../loop/permission-grants.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ToolPort } from "../../ports/tools.js";
import type { SessionRecord } from "../../ports/session.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ProviderPort, ReasoningEffort } from "../../ports/provider.js";
import type { WiringOptIns } from "./wiring-optins.js";
import type { CentralLearningTurnFactory } from "./central-learning-turn.js";

/** Canonical composition input only. Runtime construction remains in wiring.ts;
 * that existing public entry re-exports these types for current callers. */
export type WiringInput = {
  readonly centralLearning?: CentralLearningTurnFactory;
  readonly providerGuard?: (provider: ProviderPort) => ProviderPort;
  /** Explicit metered transport policy; generic provider wrappers keep normal retries. */
  readonly requestAttemptPolicy?: "single_request";
  readonly additionalTools?: ToolPort;
  readonly skillPending?: ReturnType<typeof import("../../learning/agent/subsystems/skill/host/pending-review.js").createSkillPendingReview>;
  readonly contextTokenLimit?: number;
  readonly execPolicy?: ExecPolicyGuard;
  readonly toolSelection?: readonly string[];
  readonly configuredToolSelection?: readonly string[];
  readonly toolSelectionCeiling?: readonly string[];
  readonly workflowRecords?: readonly SessionRecord[];
  readonly goal?: import("../../ports/goal.js").GoalExecutionPort;
  readonly turnId?: string;
  readonly callerMessages?: ReadonlyArray<Message>;
  /** The selected id: a shipped one, or one declared in `providers.json`. */
  readonly providerId: string;
  /**
   * The adapter family, when it is not the id. Absent — every caller that
   * predates declared providers — means the id *is* the kind, which is true for
   * all four shipped ones; present, it is what a declared provider is built
   * from, so a provider named anything can still be the family it declares.
   */
  readonly providerKind?: ProviderKind;
  /** Explicit Responses summary support resolved before adapter construction. */
  readonly reasoningSummary?: "auto";
  readonly reasoningEffort?: ReasoningEffort;
  readonly model: string;
  readonly endpoint: string;
  /**
   * The resolved credential, when one resolved. It arrives already read by
   * `CredentialPort` (see `credentials-wiring.ts`); this file never reads an
   * environment variable or a ledger itself.
   */
  readonly apiKey: string | undefined;
  readonly tokenManager?: TokenManagerLike | undefined;
  /**
   * Which account the credential belongs to. It is part of a warm entry's
   * identity, never a credential: a session built for one account is not handed
   * to another.
   */
  readonly accountId?: string | undefined;
  /**
   * The warm layer, lent by a surface that runs more than one turn. Absent —
   * `trylo run`, every single-turn caller — means the provider is built exactly
   * as it always was and nothing is cached.
   */
  readonly warm?: WarmRegistry | undefined;
  readonly workspaceRoot: string;
  /**
   * Where snapshots are stored; must sit outside `workspaceRoot`. Absent
   * means a write runs with no undo, which is how every caller that never
   * asked for a profile root behaves.
   */
  readonly checkpointRoot?: string;
  readonly permission: PermissionPort;
  readonly grants?: PermissionGrantCache;
  /**
   * Milliseconds since the epoch, so a stored window carries a real host time.
   * Absent means the wiring is built without compaction, which is also what a
   * caller that never configures a ceiling wants.
   */
  readonly nowMs?: number;
  /**
   * The already-open MCP half of the tool table. Absent — which is every caller
   * that never asked for external tools — means the run is byte-identical to
   * one that never heard of them (WP §4-D8): the composite is not built, the
   * sandbox is the workspace's own, and the catalog hash is the same string.
   *
   * The sessions are opened by the caller because opening one is async and can
   * take a real handshake; this file is synchronous by design, and a wiring
   * that could block on a child process would be a wiring that can hang a CLI.
   */
  readonly mcp?: McpToolTable;
  /**
   * 按 WP14 冻结的技能目录（每轮由组合根重建）。Absent —— 工作区与用户层都
   * 没有技能 —— wiring 根本不构造 skill 工具，catalog 哈希逐字不变（R1）。
   */
  readonly skills?: SkillCatalogPort;
} & WiringOptIns;

/** An open MCP runtime, reduced to the two things a tool table is built from. */
export type McpToolTable = {
  readonly wrapProvider?: (provider: ProviderPort) => ProviderPort;
  readonly tools: ToolPort;
  /** Exactly the names that mounted; the composite sandbox admits only these. */
  readonly toolNames: ReadonlySet<string>;
};

