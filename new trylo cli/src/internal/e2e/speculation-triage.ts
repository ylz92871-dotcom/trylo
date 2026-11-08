import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * ENG-3 五态分诊模型 (Master Plan §3.3 & §5.2)
 *
 * 与 GC (Grounding Closure) W3 分诊机制统一收口，扩展为五态闭集：
 *  - production_reachable: 经 CLI 组合根、主运行路径或发行入口直接可达的生产代码
 *  - library_reachable: 共享纯协议/合同/算法/SPI，由多个子系统消费并受合同测试保护
 *  - test_support: 仅服务于单元/集成/回归测试的测试双模、Mock 服务器与辅助 Harness
 *  - approved_deferred: 已获架构批准但受控延期接入的在跑包（有明确 Owner、消费者与接入阶段）
 *  - remove: 经所有者确认无消费者的结构性冗余（需立即物理删除，当前为 0）
 */
export type SpeculationState =
  | "production_reachable"
  | "library_reachable"
  | "test_support"
  | "approved_deferred"
  | "remove";

export const SPECULATION_STATES: readonly SpeculationState[] = [
  "production_reachable",
  "library_reachable",
  "test_support",
  "approved_deferred",
  "remove",
] as const;

export type DeferredPackageEntry = {
  readonly prefix: string;
  readonly domain: string;
  readonly owner: string;
  readonly primaryConsumer: string;
  readonly targetMilestone: string;
  readonly exitCondition: string;
  readonly justification: string;
};

/**
 * 权威 approved_deferred 清单：每一处延期模块均登记唯一责任人、目标阶段与退出条件
 */
export const APPROVED_DEFERRED_PACKAGES: readonly DeferredPackageEntry[] = [
  {
    prefix: "internal/learning/",
    domain: "Learning Engine (Methods & User)",
    owner: "Agent Learning / L01",
    primaryConsumer: "Dual-loop Learning Controller",
    targetMilestone: "L01",
    exitCondition: "Wire to runner via learning-sink after formal L01 audit",
    justification: "Active parallel workstream under L01 spec; strictly isolated by NO_LEARNING_PROFILE",
  },
  {
    prefix: "internal/integration/",
    domain: "Learning & Tooling Integration",
    owner: "Agent Learning & Extensibility / L01 & P03",
    primaryConsumer: "Dual-loop Learning Controller & Tooling Service",
    targetMilestone: "L01",
    exitCondition: "Integrate into loop when method extraction and user preferences are production-ready",
    justification: "Method learning, user learning, activation, and tooling integration runtime",
  },
  {
    prefix: "internal/adapters/learning-store/",
    domain: "Learning Store Adapter",
    owner: "Storage / L01",
    primaryConsumer: "Learning Controllers",
    targetMilestone: "L01",
    exitCondition: "Open event store when dual-loop learning enables persistence",
    justification: "File-backed append-only ledger for learning facts and outcomes",
  },
  {
    prefix: "internal/adapters/permission-store/",
    domain: "Persistent Permission Ledger",
    owner: "Security / P03",
    primaryConsumer: "Approval Policy Engine",
    targetMilestone: "P03",
    exitCondition: "Connect to CLI host approval layer when durable grants are active",
    justification: "File-backed ledger for persistent permission grants and revocations",
  },
  {
    prefix: "internal/adapters/verification-authority-store/",
    domain: "Verification Authority Store",
    owner: "Governance / P03",
    primaryConsumer: "Tooling Trust Verification",
    targetMilestone: "P03",
    exitCondition: "Wire to tool installer when cryptographically signed packages ship",
    justification: "Registry of trusted signing authorities for third-party packages",
  },
  {
    prefix: "internal/tooling/",
    domain: "Tool Acquisition & Catalog Lifecycle",
    owner: "Extensibility / P03",
    primaryConsumer: "Tool Manager CLI",
    targetMilestone: "P03",
    exitCondition: "Mount into CLI after quarantine sandbox audit completes",
    justification: "Quarantine, vetting, dynamic discovery, and catalog lifecycle",
  },
  {
    prefix: "internal/adapters/tool-acquisition/",
    domain: "Tool Downloader & Platform Fetchers",
    owner: "Extensibility / P03",
    primaryConsumer: "Tool Acquisition Vetting",
    targetMilestone: "P03",
    exitCondition: "Connect to npm/pypi/github fetchers when tool add is wired",
    justification: "Network archive fetching and SHA256 integrity checkers",
  },
  {
    prefix: "internal/mcp/",
    domain: "MCP Domain Protocol",
    owner: "Integrations / P07",
    primaryConsumer: "MCP Server Manager",
    targetMilestone: "P07",
    exitCondition: "Wire to MCP stdio/http transports when client session is bound",
    justification: "Model Context Protocol JSON-RPC envelope and session types",
  },
  {
    prefix: "internal/evaluation/",
    domain: "Outcome Evaluation",
    owner: "Evaluation / P05",
    primaryConsumer: "Experience Evaluator",
    targetMilestone: "P05",
    exitCondition: "Connect to post-run telemetry when outcome grading is enabled",
    justification: "Post-turn rubric evaluator and quality score calculator",
  },
  {
    prefix: "internal/knowledge/",
    domain: "Knowledge Base Adapters",
    owner: "Knowledge / P06",
    primaryConsumer: "Retrieval Augmentation Port",
    targetMilestone: "P06",
    exitCondition: "Wire knowledge search to system prompt when RAG is approved",
    justification: "Vector and keyword search over workspace knowledge stores",
  },
  {
    prefix: "internal/hooks/",
    domain: "Lifecycle Hooks Config & Runner",
    owner: "Extensibility / P00 CLI-PARITY-V1 WP17",
    primaryConsumer: "Loop trigger sites and WP22 agent-hook integration",
    targetMilestone: "P00 CLI-PARITY-V1 (WP27 integration)",
    exitCondition: "Session/tool/compact trigger sites wired with contract evidence; agent-hook联验 WP22",
    justification: "WP17 runner with contract tests; trigger-site wiring deferred to consumer integration",
  },
  {
    prefix: "internal/surface/protocol/",
    domain: "ACP / AG-UI Projection Surface",
    owner: "Protocols / P08",
    primaryConsumer: "Desktop & Web UI Frontends",
    targetMilestone: "P08",
    exitCondition: "Connect to WebSocket/IPC stream when desktop UI launches",
    justification: "Protocol frames projection for graphical agent dashboards",
  },
  {
    prefix: "internal/surface/cli/tui/",
    domain: "Interactive Terminal UI",
    owner: "CLI / P08",
    primaryConsumer: "Interactive Run Mode",
    targetMilestone: "P08",
    exitCondition: "Replace readline REPL with blessed/ink TUI in P08",
    justification: "Full-screen interactive ANSI terminal UI interface",
  },
];

/**
 * 分类单个生产源码文件（基于工程规范与既有 W3 分诊判定）
 */
export function classifySourceFile(normalizedRelativePath: string): SpeculationState {
  const f = normalizedRelativePath;

  // 1. Test support (fixtures, doubles, fake executors, harnesses)
  if (
    f.includes("/testing/") ||
    // Test-only old-path bridge for integration/check-learning/runtime.test.ts.
    // Remove this entry with the bridge when the separate check migration
    // switches that protected consumer to the tool subsystem entrypoint.
    f === "internal/adapters/tool-evolution/process-verifier.ts" ||
    f.endsWith("fakes.ts") ||
    f.endsWith("scenarios.ts") ||
    f.endsWith("mock-oauth-server.ts") ||
    f.startsWith("internal/e2e/")
  ) {
    return "test_support";
  }

  // 2. Production-reachable modules that were previously deferred (R4 reclassification)
  if (
    f.startsWith("internal/subagent/") ||
    f.startsWith("internal/learning/method/") ||
    // Preserve the pre-move method service, adapter and legacy-prompt classes.
    (f.startsWith("internal/learning/agent/subsystems/method/") &&
      !f.startsWith("internal/learning/agent/subsystems/method/adapters/") &&
      !f.startsWith("internal/learning/agent/subsystems/method/legacy-prompt/") &&
      f !== "internal/learning/agent/subsystems/method/orchestration/prompt-pipeline.ts") ||
    f.startsWith("internal/learning/agent/subsystems/tool/adapters/evolution/") ||
    f === "internal/learning/agent/subsystems/tool/runtime/production-activation.ts"
  ) {
    return "production_reachable";
  }

  // 3. Approved deferred packages
  for (const pkg of APPROVED_DEFERRED_PACKAGES) {
    if (f.startsWith(pkg.prefix)) {
      return "approved_deferred";
    }
  }

  // CLI sub-surfaces that are deferred for learning/subagents
  if (
    f.endsWith("tool-learning-config.ts") ||
    f.endsWith("tool-learning-doctor.ts") ||
    f.endsWith("user-learning-config.ts") ||
    f.endsWith("user-learning-doctor.ts") ||
    f.endsWith("learning-sink.ts") ||
    f.endsWith("subagent-sink.ts")
  ) {
    return "approved_deferred";
  }

  // 4. Library reachable (pure contracts, protocol codecs, shared domain primitives)
  if (
    f.startsWith("internal/contract/") ||
    f.startsWith("internal/protocol/")
  ) {
    return "library_reachable";
  }

  // 5. Production reachable (main CLI path, active loop, configuration, credentials, active adapters)
  if (
    f === "index.ts" ||
    f.startsWith("cmd/") ||
    f.startsWith("internal/loop/") ||
    f.startsWith("internal/domain/") ||
    f.startsWith("internal/ports/") ||
    f.startsWith("internal/config/") ||
    f.startsWith("internal/settings/") ||
    f.startsWith("internal/journal/") ||
    f.startsWith("internal/compaction/") ||
    f.startsWith("internal/credentials/") ||
    f.startsWith("internal/adapters/") ||
    f.startsWith("internal/surface/cli/")
  ) {
    return "production_reachable";
  }

  return "remove";
}

/**
 * 遍历并分类指定源码目录下的全部生产 TypeScript 文件
 */
export function triageAllProductionFiles(srcRoot: string): {
  readonly items: ReadonlyArray<{ readonly path: string; readonly state: SpeculationState }>;
  readonly counts: Record<SpeculationState, number>;
  readonly unclassified: readonly string[];
} {
  const allFiles: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        allFiles.push(relative(srcRoot, full).split(sep).join("/"));
      }
    }
  }

  walk(srcRoot);

  const counts: Record<SpeculationState, number> = {
    production_reachable: 0,
    library_reachable: 0,
    test_support: 0,
    approved_deferred: 0,
    remove: 0,
  };

  const items = allFiles.map((f) => {
    const state = classifySourceFile(f);
    counts[state] += 1;
    return { path: f, state };
  });

  const unclassified = items.filter((it) => !SPECULATION_STATES.includes(it.state)).map((it) => it.path);

  return { items, counts, unclassified };
}
