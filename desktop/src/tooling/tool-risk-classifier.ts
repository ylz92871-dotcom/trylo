// Trylo Desktop — Tool Risk Classifier (host-side deterministic policy).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6 (PR-2).
//
// The LAST authority before an external MCP tool runs. PR-1 already forces
// every managed server through the CLI's `ask` rules, so a call reaches the
// host as a control_request BEFORE it executes; this module decides what
// happens next:
//
//   auto_allow → the permission registry answers the CLI immediately, no UI;
//   prompt     → the registry projects the request into the ApprovalCard;
//   deny       → the registry answers deny with a machine-readable reason.
//
// Hard rules (§6.2):
//   - a classifier only accepts a REGISTERED package id + EXACT tool name.
//     An unexpected tool on a MANAGED server is denied — a tools/list drift
//     means the manifest and the classifier must be upgraded together;
//   - a server that is NOT managed (the user's own MCP, a built-in tool)
//     is routed back to the default human-approval path, never auto-decided;
//   - MCP annotations (readOnlyHint/…) are never consulted — Trylo policy is
//     the decision, annotations are hints at best (§6.2);
//   - classification is PURE and SYNCHRONOUS: no filesystem, no network, no
//     clock reads, so the permission registry can call it inline on the
//     stdout path without races or re-entrancy hazards.
//
// `at` rides inside the context (not read from a clock) so every decision is
// reproducible in tests; the router stamps it once per call.

import type { PermissionLevel } from '../permission/permission-policy';
import type { ApprovalPreview } from '../approval/approval-preview';
import { officecliClassifier } from './classifiers/officecli-classifier';
import { playwrightClassifier } from './classifiers/playwright-classifier';
import { windowsClassifier } from './classifiers/windows-mcp-classifier';
import { chromeDevtoolsClassifier } from './classifiers/chrome-devtools-classifier';
import { CAD_EDA_CLASSIFIERS } from './classifiers/cad-eda-classifier';
import type { BrowserLeaseGrant } from './classifiers/playwright-classifier';
import type { WindowsLeaseGrant } from './classifiers/windows-mcp-classifier';
import { inputDigestOf, stableStringifyInput } from './input-digest';
import type { TargetReceipt } from './classifiers/windows-mcp-classifier';

export { inputDigestOf, stableStringifyInput };
export type { BrowserLeaseGrant, TargetReceipt, WindowsLeaseGrant };

/**
 * A lease a user approval may grant (PR-3 browser origins, PR-6 screen
 * consent). The permission registry records whatever the classifier
 * proposed; the shape is tagged so sinks can route by kind.
 */
export type ToolLeaseGrant = BrowserLeaseGrant | WindowsLeaseGrant;

/** Risk vocabulary (§6.2). `read`/`workspace-write` may auto-allow; the
 *  prompt-level risks always require a decision. */
export type ToolRiskClass =
  | 'read'
  | 'workspace-write'
  | 'external'
  | 'sensitive'
  | 'destructive';

/**
 * A redacted decision record. Deliberately carries NO raw tool input, no
 * document bodies and no verbatim paths — only zones and a digest, so it is
 * safe to keep in memory or hand to diagnostics (§6.2: 「自动批准也写安全
 * 审计摘要，但不写文档正文、密码、截图或键入文本」).
 */
export interface SafeAudit {
  readonly at: number;
  readonly profileId: string;
  readonly packageId: string;
  /** Full tool name as emitted by the CLI (`mcp__<server>__<tool>`). */
  readonly toolName: string;
  readonly behavior: 'auto_allow' | 'prompt' | 'deny';
  readonly risk: ToolRiskClass | null;
  readonly reasonCode: string;
  /**
   * FNV-64 digest of the canonicalised input. In-process correlation only —
   * the same trade-off as the runtime fingerprint (`runtime-fingerprint.ts`),
   * never evidence-grade and never persisted as such.
   */
  readonly inputDigest: string;
  /** Zone per validated path field. No verbatim paths, ever. */
  readonly pathZones: readonly { readonly field: string; readonly zone: string }[];
}

export type ToolRiskDecision =
  | { readonly behavior: 'auto_allow'; readonly risk: 'read' | 'workspace-write'; readonly reasonCode: string; readonly audit: SafeAudit }
  | { readonly behavior: 'prompt'; readonly risk: 'external' | 'sensitive' | 'destructive'; readonly reasonCode: string; readonly preview: ApprovalPreview; readonly audit: SafeAudit;
      /** PR-3/PR-6 (§6.5/§6.6): a lease the user GRANTS by approving this
       *  request (browser origin, or Windows screen consent). Never created
       *  by the model — the permission registry records it only on an
       *  explicit approval. */
      readonly lease?: ToolLeaseGrant }
  | { readonly behavior: 'deny'; readonly reasonCode: string; readonly userMessage: string; readonly audit: SafeAudit };

/**
 * The router's answer for a control_request. `unmanaged` means "not one of
 * Trylo's audited packages — the default human-approval path applies". This
 * is NOT a deny: the user's own MCP servers and every built-in tool keep
 * today's behaviour.
 */
export type ToolRiskRoute =
  | { readonly behavior: 'unmanaged' }
  | ToolRiskDecision;

/** Context per spec §6.2, plus `at` (see the module note). */
export interface ToolRiskContext {
  readonly profileId: string;
  readonly packageId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permissionLevel: PermissionLevel;
  readonly projectRoot: string;
  readonly conversationId: string;
  /** Single-stamped decision time (epoch ms). */
  readonly at: number;
}

/** One package's classifier: the renderer-side twin of the manifest's
 *  `classifierId` / `mcp.serverName` / `mcp.expectedTools` triple. */
export interface PackageRiskClassifier {
  /** Matches the manifest's `classifierId`. */
  readonly id: string;
  /** The MCP server this classifier owns (`mcp__<server>__*`). */
  readonly serverName: string;
  /** EXACT tool names (full `mcp__<server>__<tool>` form). */
  readonly expectedTools: readonly string[];
  readonly classify: (context: ToolRiskContext) => ToolRiskDecision;
}

/** What the permission registry hands the router. */
export interface ToolClassifyRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permissionLevel: PermissionLevel;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly profileId: string;
  /**
   * Package ids the RUN's Profile actually activated. When present, a
   * managed package that is NOT in this set routes back to human approval —
   * §4.3 composition is explicit, so a server the Profile never merged in
   * must not be auto-decided by the host either.
   */
  readonly managedPackageIds?: readonly string[];
}

export interface ToolRiskRouter {
  classify(request: ToolClassifyRequest): ToolRiskRoute;
  /** Managed server names (diagnostics / tests). */
  serverNames(): readonly string[];
}

const MCP_PREFIX = 'mcp__';

/** Split `mcp__<server>__<tool>` into its parts; null for anything else
 *  (built-in tools, malformed names). Tool names may contain underscores,
 *  so everything after the second `__` is the tool. */
export function parseMcpToolName(
  toolName: string,
): { serverName: string; toolName: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0) return null;
  const serverName = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  if (!serverName || !tool) return null;
  return { serverName, toolName: tool };
}

function unmanaged(): ToolRiskRoute {
  return { behavior: 'unmanaged' };
}

/**
 * Build the router. The default registry ships exactly the classifiers the
 * current PR has landed — PR-2 added OfficeCLI, PR-3 Playwright, PR-6 the
 * Windows desktop classifier (its store is injected via
 * `createWindowsClassifier` so screen-consent leases stay instance-scoped),
 * PR-7 the Chrome DevTools debug classifier.
 */
export function createToolRiskClassifier(
  classifiers: readonly PackageRiskClassifier[] = [
    officecliClassifier,
    playwrightClassifier,
    windowsClassifier,
    chromeDevtoolsClassifier,
    // CAD/EDA adapters (TRYLO-CAD-EDA-TOOL-ADAPTER §7): six explicit policy
    // tables over the audited tool surfaces.
    ...CAD_EDA_CLASSIFIERS,
  ],
  options: { now?: () => number } = {},
): ToolRiskRouter {
  const now = options.now ?? (() => Date.now());
  const byServer = new Map<string, PackageRiskClassifier>();
  for (const classifier of classifiers) {
    if (byServer.has(classifier.serverName)) continue; // first wins; catalog uniqueness is pinned by tests
    byServer.set(classifier.serverName, classifier);
  }

  return {
    serverNames: () => [...byServer.keys()],

    classify(request): ToolRiskRoute {
      const parsed = parseMcpToolName(request.toolName);
      if (!parsed) return unmanaged();
      const classifier = byServer.get(parsed.serverName);
      if (!classifier) return unmanaged();

      // §4.3: only a package the Profile actually activated may be
      // auto-decided. No list (legacy runs) also routes to a human.
      if (
        request.managedPackageIds !== undefined &&
        !request.managedPackageIds.includes(classifier.id)
      ) {
        return unmanaged();
      }

      // §6.2: exact tool name only. A drift between tools/list and
      // expectedTools is an upgrade event, not a silent compatibility shim.
      if (!classifier.expectedTools.includes(request.toolName)) {
        return {
          behavior: 'deny',
          reasonCode: 'unknown_tool',
          userMessage:
            `Denied: '${request.toolName}' is not part of the pinned tool set for server ` +
            `'${classifier.serverName}'. The manifest and the host classifier must be upgraded together.`,
          audit: {
            at: now(),
            profileId: request.profileId,
            packageId: classifier.id,
            toolName: request.toolName,
            behavior: 'deny',
            risk: null,
            reasonCode: 'unknown_tool',
            inputDigest: inputDigestOf(request.input),
            pathZones: [],
          },
        };
      }

      return classifier.classify({
        profileId: request.profileId,
        packageId: classifier.id,
        toolName: request.toolName,
        input: request.input,
        permissionLevel: request.permissionLevel,
        projectRoot: request.projectRoot,
        conversationId: request.conversationId,
        at: now(),
      });
    },
  };
}

// The runtime import edge points one way only (this file → the officecli
// classifier); the classifier imports THIS module with `import type`, which
// is erased at build time, so there is no runtime cycle.
export default createToolRiskClassifier;
