import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../approval/gates.js";
import { err, ok, type Result } from "../contract/result.js";
import type {
  PackageOrigin,
  Provenance,
  ToolPackageManifest,
  ToolPackageVersion,
} from "../contract/types.js";
import { transitionCatalog } from "../catalog/lifecycle.js";
import { assertNewVersion, validateManifest, type ManifestFailure } from "../package-spi/manifest.js";

export type ToolDesign = {
  readonly problem: string;
  readonly interfaceName: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly permissions: readonly string[];
  readonly errors: readonly string[];
  readonly tests: readonly string[];
  readonly exitPath: string;
};

export type BuildRequest = {
  /** Injected one-time authorization consumer. Absent means build cannot run. */
  readonly approvalPort?: ApprovalConsumptionPort;
  /** Grant reference issued by the Permission Service; facts are verified by the store. */
  readonly token?: ApprovalGrantRef;
  readonly now: string;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly design: ToolDesign;
  readonly origin: PackageOrigin;
  readonly parent?: ToolPackageVersion;
  readonly noSuitableCandidate: boolean;
  readonly narrowGap: boolean;
  readonly taskLocal: boolean;
  readonly manifest: ToolPackageManifest;
  readonly provenance: Provenance;
  readonly contentHash: string;
};

export type BuildFailure =
  | ApprovalGateFailure
  | ManifestFailure
  | "design_incomplete"
  | "not_authorized_to_build"
  | "task_local_not_cataloged"
  | "optimized_missing_upstream"
  | "illegal_catalog_transition";

export function designIsComplete(design: ToolDesign): boolean {
  return (
    design.problem.length > 0 &&
    design.interfaceName.length > 0 &&
    design.inputs.length > 0 &&
    design.outputs.length > 0 &&
    design.tests.length > 0 &&
    design.exitPath.length > 0
  );
}

export async function buildPackageVersion(
  request: BuildRequest,
): Promise<Result<ToolPackageVersion, BuildFailure>> {
  if (!request.noSuitableCandidate && !request.narrowGap) {
    return err("not_authorized_to_build", "patch/create requires no suitable candidate or a narrow gap");
  }
  if (!designIsComplete(request.design)) {
    return err("design_incomplete", "CREATOR-style design must precede build");
  }
  if (request.taskLocal) {
    return err("task_local_not_cataloged", "temporary scripts stay task-local and do not enter My Tools");
  }
  const gate = await consumeApproval(request.approvalPort, {
    action: "modify",
    candidateId: request.candidateId,
    packageVersionId: request.packageVersionId,
    scope: request.scope,
    now: request.now,
    ...(request.token === undefined ? {} : { token: request.token }),
  });
  if (!gate.ok) {
    return gate;
  }
  const manifest = validateManifest(request.manifest);
  if (!manifest.ok) {
    return manifest;
  }
  if (request.origin === "optimized") {
    const parentId = request.provenance.parentVersionId;
    if (parentId === undefined || request.provenance.upstreamUrl.length === 0) {
      return err("optimized_missing_upstream", "optimized tools must keep upstream/parent provenance");
    }
  }
  const waiting: ToolPackageVersion = {
    packageVersionId: request.packageVersionId,
    identity: request.manifest.identity,
    version: request.manifest.version,
    origin: request.origin,
    contentHash: request.contentHash,
    manifest: request.manifest,
    licenseSpdx: request.manifest.licenseSpdx,
    provenance: request.provenance,
    catalogState: "awaiting_modify_approval",
  };
  const designing = transitionCatalog(waiting, "designing");
  if (!designing.ok) {
    return designing;
  }
  const building = transitionCatalog(designing.value, "building");
  if (!building.ok) {
    return building;
  }
  const quarantined = transitionCatalog(building.value, "quarantined");
  if (!quarantined.ok) {
    return quarantined;
  }
  const versioned = assertNewVersion(request.parent, quarantined.value);
  if (!versioned.ok) {
    return versioned;
  }
  return ok(quarantined.value);
}

export type DescriptionVersion = {
  readonly descriptionVersionId: string;
  readonly packageVersionId: string;
  readonly text: string;
  readonly comparedTrajectoryIds: readonly string[];
};

export function refineDescription(
  packageVersionId: string,
  previousText: string,
  trajectoryIds: readonly string[],
  nextText: string,
): Result<DescriptionVersion, "no_trajectory_evidence" | "unchanged"> {
  if (trajectoryIds.length === 0) {
    return err("no_trajectory_evidence", "DRAFT refinement requires real trajectories");
  }
  if (nextText === previousText) {
    return err("unchanged", "refinement must produce a new description version");
  }
  return ok({
    descriptionVersionId: `${packageVersionId}:desc:${trajectoryIds.length}`,
    packageVersionId,
    text: nextText,
    comparedTrajectoryIds: trajectoryIds,
  });
}
