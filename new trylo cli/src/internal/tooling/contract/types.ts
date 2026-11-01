export type GapKind =
  | "tool_not_found"
  | "repeated_tool_failure"
  | "poor_schema_or_description"
  | "platform_incompatible"
  | "excessive_manual_workaround"
  | "capability_mismatch";

export type GapDecisionKind = GapKind | "existing_tool_good_enough" | "below_repeat_threshold";

export type Criticality = "low" | "normal" | "high";

export type ObservationKind =
  | "tool_not_found"
  | "tool_failure"
  | "schema_friction"
  | "platform_incompatible"
  | "manual_workaround"
  | "capability_mismatch"
  | "success";

export type ToolLearningObservation = {
  readonly observationId: string;
  readonly kind: ObservationKind;
  readonly capability: string;
  readonly taskFamily: string;
  readonly criticality: Criticality;
  readonly fallbackAvailable: boolean;
  readonly recordedAt: string;
  readonly toolName?: string;
  readonly platform?: string;
  readonly notes?: string;
};

export type ToolGapDraft = {
  readonly gapId: string;
  readonly kind: GapKind;
  readonly observationIds: readonly string[];
  readonly capability: string;
  readonly taskFamily: string;
  readonly criticality: Criticality;
  readonly repeatCount: number;
  readonly fallbackAvailable: boolean;
  readonly explanation: string;
};

export type GapDetection =
  | { readonly decision: "gap"; readonly gap: ToolGapDraft }
  | {
      readonly decision: "no_change";
      readonly reason: "existing_tool_good_enough" | "below_repeat_threshold";
      readonly observationIds: readonly string[];
      readonly explanation: string;
    };

export type ProposedUse = "reference" | "leaf" | "invasive" | "core-fork";

export type OfficialIdentity = "official" | "unverified" | "impersonation_risk";

export type InterfaceKind = "mcp" | "cli" | "library" | "unknown";

export type LicenseSpdx =
  | "MIT"
  | "ISC"
  | "BSD-2-Clause"
  | "BSD-3-Clause"
  | "0BSD"
  | "Apache-2.0"
  | "GPL-2.0-only"
  | "GPL-3.0-only"
  | "AGPL-3.0-only"
  | "UNLICENSED"
  | "UNKNOWN"
  | "SOURCE-AVAILABLE";

export type ToolCandidate = {
  readonly candidateId: string;
  readonly name: string;
  readonly sourceUrl: string;
  readonly upstreamUrl: string;
  readonly commitOrVersion: string;
  readonly licenseSpdx: LicenseSpdx;
  readonly proposedUse: ProposedUse;
  readonly capabilities: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly windowsEvidence: "tested" | "claimed" | "absent";
  readonly interfaceKind: InterfaceKind;
  readonly exitPath: string;
  readonly unverifiableFields: readonly string[];
  readonly officialIdentity: OfficialIdentity;
  readonly fromOpenTree: boolean;
  readonly maintainerDepth: "deep" | "shallow" | "unknown";
  readonly releaseMaturity: "stable" | "stagnant" | "unknown";
  readonly starCount: number;
  readonly hasVendoredBinary: boolean;
  readonly licenseMatchesVendored: boolean;
  readonly noticePresent: boolean;
  readonly sbomPresent: boolean;
  readonly typeLeakRisk: "none" | "present";
  readonly patentAudit: "complete" | "missing";
  readonly bundleAudit: "complete" | "missing";
  readonly supplyChainRisk: "low" | "medium" | "high";
  readonly dependencySbom: string;
};

export type VettingConclusion = "reject" | "reference_only" | "isolated_trial" | "eligible";

export type LicenseDecision =
  | { readonly decision: "prefer"; readonly spdx: LicenseSpdx }
  | {
      readonly decision: "apache_needs_audit";
      readonly spdx: "Apache-2.0";
      readonly missing: readonly string[];
    }
  | { readonly decision: "reject"; readonly spdx: LicenseSpdx; readonly reason: string };

export type PackageOrigin = "direct" | "optimized" | "self_created";

export type CatalogLifecycle =
  | "discovered"
  | "assessed"
  | "awaiting_acquire_approval"
  | "quarantined"
  | "verifying"
  | "verified"
  | "rejected"
  | "awaiting_modify_approval"
  | "designing"
  | "building"
  | "awaiting_activation_approval";

export type BoardLifecycle = "shadow" | "active" | "suspended" | "rolled_back" | "retired";

export type DisplayLifecycle = CatalogLifecycle | BoardLifecycle;

export type Provenance = {
  readonly sourceUrl: string;
  readonly upstreamUrl: string;
  readonly commit: string;
  readonly sbom: string;
  readonly parentVersionId?: string;
  readonly downloadMethod: "fake_fixture";
};

type ToolPackageManifestBase = {
  readonly identity: string;
  readonly version: string;
  readonly origin: PackageOrigin;
  readonly licenseSpdx: LicenseSpdx;
  readonly entrypoint: string;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly processIsolation: true;
  readonly cwdWhitelist: readonly string[];
  readonly envWhitelist: readonly string[];
  readonly secretsWhitelist: readonly string[];
  readonly healthProbe: true;
  readonly alwaysLoad: boolean;
  readonly shouldDefer: boolean;
  readonly cancelSupported: true;
  readonly timeoutMs: number;
  readonly idempotencyKeyRequired: true;
  readonly sideEffectCommitPoint: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly resultChars: number;
  readonly postinstall: "forbidden";
  readonly thirdPartyTypes: "isolated" | "leaked";
};

/** Missing runtimeProfile preserves the original MCP stdio wire format. */
export type McpToolPackageManifest = ToolPackageManifestBase & {
  readonly runtimeProfile?: "mcp_stdio";
  readonly mcpSchemaVersion: string;
  readonly mcpTransport: "stdio";
};

/** A separate, zero-IO script ABI. It never advertises an MCP server. */
export type JsonFunctionToolPackageManifest = ToolPackageManifestBase & {
  readonly runtimeProfile: "confined_json_function_v1";
  readonly moduleFormat: "commonjs";
  readonly inputTransport: "json";
};

/** Managed third-party Node entrypoints have their own ABI and are never passed to the JSON-function evaluator. */
export type NodePackageToolManifest = ToolPackageManifestBase & {
  readonly runtimeProfile: "confined_npm_cli_v1" | "confined_npm_mcp_v1";
  readonly moduleFormat: "node_package";
  readonly inputTransport: "argv_stdin" | "mcp_stdio";
};
export type ToolPackageManifest = McpToolPackageManifest | JsonFunctionToolPackageManifest | NodePackageToolManifest;

export type ToolPackageVersion = {
  readonly packageVersionId: string;
  readonly identity: string;
  readonly version: string;
  readonly origin: PackageOrigin;
  readonly contentHash: string;
  readonly manifest: ToolPackageManifest;
  readonly licenseSpdx: LicenseSpdx;
  readonly provenance: Provenance;
  readonly catalogState: CatalogLifecycle;
  readonly verificationRef?: string;
};

export type ToolBindingDraft = {
  readonly draftId: string;
  readonly scope: string;
  readonly taskFamily: string;
  readonly packageVersionId: string;
  readonly candidateId: string;
};

export type BoardActivationView = {
  readonly packageVersionId: string;
  readonly scope: string;
  readonly state: BoardLifecycle;
  readonly boardSequence: number;
};

export type ValidationActor = "generator" | "verifier";

export type ValidationStageName =
  | "source_license_provenance"
  | "archive_path_manifest_schema"
  | "static_secret_malware_api"
  | "type_build_unit"
  | "sandbox_smoke"
  | "permission_malicious_bounds"
  | "cancel_timeout_crash"
  | "idempotency_side_effects"
  | "baseline_regression"
  | "independent_verdict";

export const VALIDATION_STAGE_ORDER: readonly ValidationStageName[] = [
  "source_license_provenance",
  "archive_path_manifest_schema",
  "static_secret_malware_api",
  "type_build_unit",
  "sandbox_smoke",
  "permission_malicious_bounds",
  "cancel_timeout_crash",
  "idempotency_side_effects",
  "baseline_regression",
  "independent_verdict",
];

export type StageResult = {
  readonly stage: ValidationStageName;
  readonly passed: boolean;
  readonly detail: string;
};

export type ValidationRecord = {
  readonly validationId: string;
  readonly packageVersionId: string;
  readonly stages: readonly StageResult[];
  readonly verdict: "pass" | "fail";
  readonly actor: ValidationActor;
};

export type MyToolsEntry = {
  readonly identity: string;
  readonly packageVersionId: string;
  readonly version: string;
  readonly origin: PackageOrigin;
  readonly sourceUrl: string;
  readonly upstreamUrl: string;
  readonly commit: string;
  readonly licenseSpdx: LicenseSpdx;
  readonly lifecycle: DisplayLifecycle;
  readonly capabilities: readonly string[];
  readonly permissionNeeds: readonly string[];
  readonly scopeBinding?: string;
  readonly lastValidation?: "pass" | "fail";
  readonly health?: "healthy" | "degraded" | "unknown";
  readonly previousVersionId?: string;
  readonly rollbackAvailable: boolean;
  readonly contributionBundleStatus: "none" | "prepared" | "awaiting_review";
  readonly effect?: "improved" | "regressed" | "unknown";
};

export type ToolingEvent =
  | {
      readonly kind: "package_recorded";
      readonly sequence: number;
      readonly pkg: ToolPackageVersion;
    }
  | {
      readonly kind: "validation_recorded";
      readonly sequence: number;
      readonly record: ValidationRecord;
    }
  | {
      readonly kind: "contribution_recorded";
      readonly sequence: number;
      readonly packageVersionId: string;
      readonly status: "none" | "prepared" | "awaiting_review";
    }
  | {
      readonly kind: "health_recorded";
      readonly sequence: number;
      readonly packageVersionId: string;
      readonly health: "healthy" | "degraded" | "unknown";
    }
  | {
      readonly kind: "effect_recorded";
      readonly sequence: number;
      readonly packageVersionId: string;
      readonly effect: "improved" | "regressed" | "unknown";
    }
  | {
      readonly kind: "ui_command_emitted";
      readonly sequence: number;
      readonly command: ToolBoardCommandDraft;
    };

export type ToolBoardCommandDraft =
  | { readonly kind: "submit_gap"; readonly gap: ToolGapDraft }
  | { readonly kind: "submit_candidate"; readonly candidate: ToolCandidate }
  | { readonly kind: "submit_binding_draft"; readonly draft: ToolBindingDraft }
  | { readonly kind: "submit_evidence"; readonly evidenceId: string; readonly summary: string }
  | { readonly kind: "request_suspend"; readonly packageVersionId: string; readonly reason: string }
  | { readonly kind: "request_rollback"; readonly packageVersionId: string; readonly reason: string };

export type CuratorJobState =
  | "running"
  | "waiting_approval"
  | "denied"
  | "expired"
  | "failed"
  | "stopped_breaker"
  | "completed";

export type ForbiddenSideEffect =
  | "network"
  | "shell"
  | "clone"
  | "download"
  | "install"
  | "execute"
  | "push"
  | "issue"
  | "pull_request"
  | "contact_maintainer"
  | "tool_switch";
