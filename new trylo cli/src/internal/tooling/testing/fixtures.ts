import type {
  ToolLearningObservation,
  Provenance,
  ToolCandidate,
  McpToolPackageManifest,
  ToolPackageVersion,
} from "../contract/types.js";
import type { ApprovalGrantRef, GrantIssuanceInput } from "../../ports/approval-consumption.js";
import { createMemoryPermissionStore, type MemoryPermissionStore } from "../../adapters/permission-store/index.js";
import type { ArchiveFixture } from "../quarantine/archive-guard.js";
import type { FakeValidationSignals } from "../validation/pipeline.js";
import type { ToolDesign } from "../builder/design.js";

export function candidate(overrides: Partial<ToolCandidate> & Pick<ToolCandidate, "candidateId" | "name">): ToolCandidate {
  return {
    sourceUrl: `https://example.invalid/${overrides.name}`,
    upstreamUrl: `https://example.invalid/${overrides.name}`,
    commitOrVersion: "abc123",
    licenseSpdx: "MIT",
    proposedUse: "leaf",
    capabilities: ["pdf"],
    requiredPermissions: ["fs.read"],
    windowsEvidence: "tested",
    interfaceKind: "mcp",
    exitPath: "remove local package",
    unverifiableFields: ["starCount"],
    officialIdentity: "official",
    fromOpenTree: false,
    maintainerDepth: "deep",
    releaseMaturity: "stable",
    starCount: 1200,
    hasVendoredBinary: false,
    licenseMatchesVendored: true,
    noticePresent: true,
    sbomPresent: true,
    typeLeakRisk: "none",
    patentAudit: "complete",
    bundleAudit: "complete",
    supplyChainRisk: "low",
    dependencySbom: "sbom:default",
    ...overrides,
  };
}

export function observation(
  overrides: Partial<ToolLearningObservation> &
    Pick<ToolLearningObservation, "observationId" | "kind">,
): ToolLearningObservation {
  return {
    capability: "pdf",
    taskFamily: "docs",
    criticality: "normal",
    fallbackAvailable: true,
    recordedAt: "2026-09-12T00:00:00Z",
    toolName: "read",
    ...overrides,
  };
}

export function manifest(overrides: Partial<McpToolPackageManifest> = {}): McpToolPackageManifest {
  return {
    identity: "pdf-lint",
    version: "1.0.0",
    origin: "direct",
    licenseSpdx: "MIT",
    entrypoint: "server.mjs",
    capabilities: ["pdf"],
    permissions: ["fs.read"],
    mcpSchemaVersion: "2024-11-05",
    mcpTransport: "stdio",
    processIsolation: true,
    cwdWhitelist: ["."],
    envWhitelist: ["PATH"],
    secretsWhitelist: [],
    healthProbe: true,
    alwaysLoad: false,
    shouldDefer: true,
    cancelSupported: true,
    timeoutMs: 5000,
    idempotencyKeyRequired: true,
    sideEffectCommitPoint: "after-tool-result",
    stdoutBytes: 4096,
    stderrBytes: 4096,
    resultChars: 2000,
    postinstall: "forbidden",
    thirdPartyTypes: "isolated",
    ...overrides,
  };
}

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    sourceUrl: "https://example.invalid/pdf-lint",
    upstreamUrl: "https://example.invalid/pdf-lint",
    commit: "abc123",
    sbom: "sbom:pdf-lint:1",
    downloadMethod: "fake_fixture",
    ...overrides,
  };
}

export function pkg(overrides: Partial<ToolPackageVersion> = {}): ToolPackageVersion {
  const man = overrides.manifest ?? manifest();
  return {
    packageVersionId: "pkg:pdf-lint:1.0.0",
    identity: man.identity,
    version: man.version,
    origin: man.origin,
    contentHash: "hash-1",
    manifest: man,
    licenseSpdx: man.licenseSpdx,
    provenance: provenance(),
    catalogState: "quarantined",
    ...overrides,
  };
}

/**
 * Grant *issuance input* fixture (external audit P0-1): tests act as the
 * Permission Service by issuing through a Permission store; they can no longer
 * hand-craft authorization facts at the consumption boundary.
 */
export function grantInput(
  overrides: Partial<GrantIssuanceInput> & Pick<GrantIssuanceInput, "action">,
): GrantIssuanceInput {
  return {
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    scope: "docs",
    issuedAt: "2026-09-13T00:00:00.000Z",
    expiry: "2026-12-01T00:00:00.000Z",
    ...overrides,
  };
}

export function memoryPermissionStore(): MemoryPermissionStore {
  return createMemoryPermissionStore();
}

/** 以 Permission Service 的身份签发一个 grant，返回调用方唯一能持有的引用。 */
export async function issuedGrantRef(
  store: MemoryPermissionStore,
  action: GrantIssuanceInput["action"],
  overrides: Partial<Omit<GrantIssuanceInput, "action">> = {},
): Promise<ApprovalGrantRef> {
  const issued = await store.issue(grantInput({ action, ...overrides }));
  if (!issued.ok) {
    throw new Error("fixture grant issuance failed");
  }
  return { grantId: issued.grant.grantId };
}

export function archive(overrides: Partial<ArchiveFixture> = {}): ArchiveFixture {
  return {
    name: "pdf-lint",
    expectedHash: "hash-1",
    actualHash: "hash-1",
    uncompressedBytes: 128,
    entries: [
      { path: "manifest.json", kind: "file", size: 20, content: "{}" },
      { path: "server.mjs", kind: "file", size: 20, content: "export {}" },
    ],
    ...overrides,
  };
}

export function passingSignals(overrides: Partial<FakeValidationSignals> = {}): FakeValidationSignals {
  return {
    suspiciousApi: false,
    unitTestsPass: true,
    sandboxSmokePass: true,
    permissionDenialHonored: true,
    maliciousInputRejected: true,
    cancelWorks: true,
    timeoutWorks: true,
    crashClassifiedUnknown: true,
    idempotent: true,
    baselineRegressionPass: true,
    secretsInTree: false,
    healthPass: true,
    ...overrides,
  };
}

export function design(overrides: Partial<ToolDesign> = {}): ToolDesign {
  return {
    problem: "pdf tables unreadable",
    interfaceName: "pdf_lint",
    inputs: ["path"],
    outputs: ["issues"],
    permissions: ["fs.read"],
    errors: ["not_found"],
    tests: ["empty pdf"],
    exitPath: "delete package version",
    ...overrides,
  };
}
