// Trylo Desktop — Office delivery validation (renderer side, PR-5 spec §11).
//
// The deterministic validation pipeline is a Service-Host capability
// (§11: 「验证工具不必都暴露成 MCP，确定性 host pipeline 更可靠」). This module
// is the renderer's typed handle — same split as the artifact promoter:
// FS / process truth lives on the sidecar, this file only knows how to build
// a request from a run scope and how to fold the verdict into the persisted
// artifact record (through the results-domain whitelist, never around it).

import type {
  ToolingOfficeArtifactValidation,
  ToolingOfficeValidationCapabilitiesResult,
  ToolingValidateOfficeArtifactsResult,
} from '../services-host/methods';
import type { ToolingFacade } from './tooling-facade';
import type {
  OfficeCheckId,
  OfficeCheckStatus,
  OfficeVerificationStatus,
  StoredWorkArtifact,
  StoredWorkArtifactVerification,
} from '../results/conversation-result-types';

export type {
  ToolingOfficeArtifactValidation,
  ToolingOfficeValidationCapabilitiesResult,
  ToolingValidateOfficeArtifactsResult,
};

export interface OfficeArtifactRequest {
  readonly id: string;
  readonly relativePath: string;
}

export interface OfficeValidationScope {
  readonly projectRoot: string;
}

/**
 * §4.4 capability probe for the two validation engines. Diagnostics/Settings
 * surface; `null` on transport failure.
 */
export async function officeValidationCapabilities(
  facade: ToolingFacade,
  params: { refresh?: boolean } = {},
): Promise<ToolingOfficeValidationCapabilitiesResult | null> {
  return facade.officeValidationCapabilities(params);
}

/**
 * Run the §11 pipeline over one run's Office deliverables. `null` on
 * transport failure — the caller treats that as "no verdict this time",
 * never as a pass.
 */
export async function validateOfficeArtifacts(
  facade: ToolingFacade,
  scope: OfficeValidationScope,
  artifacts: readonly OfficeArtifactRequest[],
): Promise<ToolingValidateOfficeArtifactsResult | null> {
  return facade.validateOfficeArtifacts({
    projectRoot: scope.projectRoot,
    artifacts,
  });
}

// ── verdict folding (protocol → persisted domain) ─────────────────────

const CHECK_IDS: readonly OfficeCheckId[] = [
  'file-present', 'container-match', 'structure', 'officecli-validate', 'libreoffice-roundtrip',
];
const CHECK_STATUSES: readonly OfficeCheckStatus[] = ['passed', 'failed', 'skipped'];
const VERDICT_STATUSES: readonly OfficeVerificationStatus[] = ['verified', 'partial', 'failed', 'skipped'];

function isOneOf<T extends string>(value: unknown, set: readonly T[]): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

/**
 * Fold one protocol verdict into the persisted `StoredWorkArtifact`.
 * Defensive on purpose: the sidecar's vocabulary is closed, but the record
 * is about to be normalized again on the way to disk — the two whitelists
 * must agree, and this mapping is where that agreement lives.
 */
export function verificationFromProtocol(
  validation: ToolingOfficeArtifactValidation | undefined,
): StoredWorkArtifactVerification | undefined {
  if (!validation) return undefined;
  if (!isOneOf(validation.status, VERDICT_STATUSES)) return undefined;
  return {
    status: validation.status,
    checkedAt: Number.isFinite(validation.checkedAt) ? Math.floor(validation.checkedAt) : 0,
    checks: (validation.checks ?? [])
      .filter((entry) => isOneOf(entry?.id, CHECK_IDS) && isOneOf(entry?.status, CHECK_STATUSES))
      .map((entry) => ({
        id: entry.id,
        status: entry.status,
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
    ...(validation.skippedCapabilities?.length
      ? { skippedCapabilities: validation.skippedCapabilities }
      : {}),
    ...(validation.reasonCode ? { reasonCode: validation.reasonCode } : {}),
  };
}

/**
 * Attach verification verdicts to the stored artifacts of a result snapshot.
 * Pure: returns the same array object when nothing matched, so callers can
 * cheaply detect "no change".
 */
export function attachVerifications(
  artifacts: readonly StoredWorkArtifact[],
  verdicts: readonly ToolingOfficeArtifactValidation[],
): readonly StoredWorkArtifact[] {
  if (verdicts.length === 0) return artifacts;
  const byId = new Map<string, ToolingOfficeArtifactValidation>();
  const byPath = new Map<string, ToolingOfficeArtifactValidation>();
  for (const verdict of verdicts) {
    if (verdict?.id) byId.set(verdict.id, verdict);
    if (verdict?.relativePath) byPath.set(verdict.relativePath, verdict);
  }
  let changed = false;
  const next = artifacts.map((artifact): StoredWorkArtifact => {
    const verdict =
      byId.get(artifact.id) ??
      byPath.get(artifact.target.kind === 'file' ? artifact.target.relativePath : '');
    if (!verdict) return artifact;
    const verification = verificationFromProtocol(verdict);
    if (!verification) return artifact;
    changed = true;
    // Only the verdict is new; the artifact's own timeline fields are
    // untouched (a verification is not a content change — §8.5).
    return { ...artifact, verification };
  });
  return changed ? next : artifacts;
}

/**
 * Aggregate a result snapshot's verification verdicts into the three-state
 * §11 summary the ResultDock shows: 已验证 / 部分验证 / 验证失败.
 * Artifacts without a verdict are excluded (they were never verified).
 */
export function verificationSummary(
  artifacts: readonly StoredWorkArtifact[],
): { verified: number; partial: number; failed: number } | null {
  let verified = 0;
  let partial = 0;
  let failed = 0;
  for (const artifact of artifacts) {
    const status = artifact.verification?.status;
    if (status === 'verified') verified += 1;
    else if (status === 'partial') partial += 1;
    else if (status === 'failed') failed += 1;
  }
  return verified + partial + failed > 0 ? { verified, partial, failed } : null;
}

/** Whether a run's verification outcome should degrade its status (§11). */
export function hasFailedVerification(
  artifacts: readonly StoredWorkArtifact[],
): boolean {
  return artifacts.some((artifact) => artifact.verification?.status === 'failed');
}
