import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../../../../../../tooling/approval/gates.js";
import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { Provenance, ToolPackageManifest, ToolPackageVersion } from "../../../../../../tooling/contract/types.js";
import { transitionCatalog } from "../../../../../../tooling/catalog/lifecycle.js";
import { inspectArchive, type ArchiveFailure, type ArchiveFixture } from "../../assets/quarantine/archive-guard.js";

export type AcquireRequest = {
  /** Injected one-time authorization consumer. Absent means acquire cannot run. */
  readonly approvalPort?: ApprovalConsumptionPort;
  /** Grant reference issued by the Permission Service; facts are verified by the store. */
  readonly token?: ApprovalGrantRef;
  readonly now: string;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly quarantineRoot: string;
  readonly archive: ArchiveFixture;
  readonly compressedBytes: number;
  readonly manifest: ToolPackageManifest;
  readonly provenance: Provenance;
};

export type AcquireFailure =
  | ArchiveFailure
  | ApprovalGateFailure
  | "outside_quarantine"
  | "forbidden_root"
  | "missing_sbom"
  | "optimized_missing_upstream"
  | "illegal_catalog_transition";

export function isForbiddenQuarantineRoot(root: string): boolean {
  const normalized = path.resolve(root).replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  const ownerIndex = parts.lastIndexOf("internal");
  const owner = ownerIndex >= 0 ? parts[ownerIndex + 1] : undefined;
  const coreOwners: ReadonlySet<string> = new Set(["loop", "domain", "protocol", "ports"]);
  if (owner !== undefined && coreOwners.has(owner)) {
    return true;
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home.length > 0 && path.resolve(root) === path.resolve(home, ".trylo")) {
    return true;
  }

  const roaming = process.env.APPDATA ?? "";
  if (roaming.length > 0 && path.resolve(root) === path.resolve(roaming)) {
    return true;
  }

  const pathEnv = process.env.PATH ?? "";

  for (const part of pathEnv.split(path.delimiter)) {
    if (part.length > 0 && path.resolve(part) === path.resolve(root)) {
      return true;
    }
  }

  return false;
}

function resolveInsideRoot(root: string, relativePath: string): Result<string, "outside_quarantine"> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    return err("outside_quarantine", "acquire cannot write outside quarantine root");
  }

  return ok(resolved);
}

export async function acquireToQuarantine(
  request: AcquireRequest,
): Promise<Result<ToolPackageVersion, AcquireFailure>> {
  const gate = await consumeApproval(request.approvalPort, {
    action: "acquire",
    candidateId: request.candidateId,
    packageVersionId: request.packageVersionId,
    scope: request.scope,
    now: request.now,
    ...(request.token === undefined ? {} : { token: request.token }),
  });
  if (!gate.ok) {
    return gate;
  }

  if (isForbiddenQuarantineRoot(request.quarantineRoot)) {
    return err("forbidden_root", "quarantine cannot write PATH, core source, or global config roots");
  }

  if (request.provenance.sbom.length === 0) {
    return err("missing_sbom", "acquire requires SBOM provenance");
  }

  if (request.manifest.origin === "optimized") {
    const parent = request.provenance.parentVersionId;
    if (parent === undefined || request.provenance.upstreamUrl.length === 0) {
      return err("optimized_missing_upstream", "optimized packages must retain upstream and parent");
    }
  }

  const inspected = inspectArchive(request.archive, request.compressedBytes);
  if (!inspected.ok) {
    return inspected;
  }

  const rootCheck = resolveInsideRoot(request.quarantineRoot, ".");
  if (!rootCheck.ok) {
    return rootCheck;
  }

  await mkdir(request.quarantineRoot, { recursive: true });

  for (const entry of inspected.value) {
    if (entry.kind === "directory") {
      const dir = resolveInsideRoot(request.quarantineRoot, entry.path);
      if (!dir.ok) {
        return dir;
      }
      await mkdir(dir.value, { recursive: true });
      continue;
    }
    if (entry.kind === "file") {
      const file = resolveInsideRoot(request.quarantineRoot, entry.path);
      if (!file.ok) {
        return file;
      }
      await mkdir(path.dirname(file.value), { recursive: true });
      await writeFile(file.value, entry.content ?? "", "utf8");
    }
  }

  const pending: ToolPackageVersion = {
    packageVersionId: request.packageVersionId,
    identity: request.manifest.identity,
    version: request.manifest.version,
    origin: request.manifest.origin,
    contentHash: request.archive.actualHash,
    manifest: request.manifest,
    licenseSpdx: request.manifest.licenseSpdx,
    provenance: request.provenance,
    catalogState: "awaiting_acquire_approval",
  };

  return transitionCatalog(pending, "quarantined");
}
