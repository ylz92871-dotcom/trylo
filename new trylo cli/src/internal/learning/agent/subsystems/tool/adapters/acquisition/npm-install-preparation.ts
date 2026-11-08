import { createHash } from "node:crypto";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../../../../../ports/approval-consumption.js";
import { consumeApproval } from "../../../../../../tooling/approval/gates.js";
import type { JsonObject } from "../../../../../../protocol/envelope.js";
import type { NpmInstallPlan } from "../../../../../../tooling/contract/npm-install.js";
import type { NpmInstallTarget } from "../../../../../../tooling/contract/npm-tree.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { recordOf } from "../../domain/evolution/parse.js";
import { planNpmLockedTree } from "./npm-tree-plan.js";
import { fetchJson } from "./fetch-json.js";
import { fetchArchive } from "./fetch-archive.js";
import { readNpmTarball } from "./ustar-reader.js";
import { decodeNpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { npmRepositoryClaim } from "./npm-repository.js";
import { inspectNpmInstallContent } from "./npm-install-content.js";
import { npmInstallErrorCode } from "./npm-install.js";
import { sha256Bytes } from "./npm-package-check.js";
import type { HttpTransport } from "./transport.js";

export type NpmPreparationRequest = {
  readonly scope: string; readonly name: string; readonly version: string;
  readonly target: NpmInstallTarget; readonly lock: JsonObject;
};

/** Authorizes collecting this exact closure's source bytes, not executing its code. */
export function npmPreparationId(request: NpmPreparationRequest): string {
  return `npm-preparation_v1_${contentHashOf(request)}`;
}

/** Build the installer's existing exact-byte plan from registry and archive facts.
 * The learning model selects a package; it never has to invent hashes, source revisions,
 * license paths or the dependency closure's inspection results. */
export async function prepareNpmInstallation(request: NpmPreparationRequest, options: {
  readonly approval: ApprovalConsumptionPort; readonly token: ApprovalGrantRef;
  readonly now: () => number; readonly signal: AbortSignal; readonly transport: HttpTransport;
}) {
  const planned = planNpmLockedTree(request);
  if (!planned.ok) return planned;

  if (options.signal.aborted) return failure("cancelled");

  const preparationId = npmPreparationId(request);
  const approved = await consumeApproval(options.approval, { token: options.token, action: "acquire",
    candidateId: preparationId, packageVersionId: preparationId, scope: request.scope, now: new Date(options.now()).toISOString() });
  if (!approved.ok) return failure(approved.code);

  try {
    const packages: NpmInstallPlan["packages"][number][] = [], archives = new Map<string, Uint8Array>();
    let compressedBytes = 0;
    // Repeated physical locations can share one exact archive, while their dependency edges remain distinct.
    const reviewed = new Map<string, NpmInstallPlan["packages"][number]["review"]>();

    for (const pkg of planned.tree.packages) {
      if (options.signal.aborted) return failure("cancelled");

      const identity = JSON.stringify([pkg.name, pkg.version, pkg.integrity]);
      const prior = reviewed.get(identity);
      if (prior !== undefined) {
        packages.push({ location: pkg.location, review: prior });
        continue;
      }

      const metadata = await fetchJson(options.transport, `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, options.signal);
      if (!metadata.ok) return failure(metadata.code);

      if (!recordOf(metadata.value) || metadata.value.name !== pkg.name || metadata.value.version !== pkg.version) return failure("npm_metadata_identity_mismatch");

      const fetched = await fetchArchive(options.transport, pkg.archiveUrl, options.signal);
      if (!fetched.ok) return failure(fetched.code);

      compressedBytes += fetched.value.bytes;

      if (compressedBytes > 64 * 1024 * 1024) return failure("npm_install_archive_limit");

      if (`sha512-${createHash("sha512").update(fetched.value.body).digest("base64")}` !== pkg.integrity) return failure("npm_archive_integrity_mismatch");

      const review = reviewArchive(request.scope, pkg, metadata.value, fetched.value.body);
      if (review === undefined) return failure("npm_source_review_incomplete");

      reviewed.set(identity, review);
      archives.set(pkg.archiveUrl, fetched.value.body);
      packages.push({ location: pkg.location, review });
    }

    const plan: NpmInstallPlan = { type: "npm_install_plan", schemaVersion: 1, lock: request.lock, tree: planned.tree, packages };
    const byLocation = new Map(planned.tree.packages.map(pkg => [pkg.location, archives.get(pkg.archiveUrl)!]));

    inspectNpmInstallContent(plan, byLocation);

    return { ok: true as const, preparationId, approvalGrantId: approved.value.grantId, plan, archives };
  } catch (error) { return failure(options.signal.aborted ? "cancelled" : npmInstallErrorCode(error)); }
}

function reviewArchive(scope: string, pkg: { readonly name: string; readonly version: string; readonly archiveUrl: string; readonly integrity: string }, metadata: Record<string, unknown>, body: Uint8Array) {
  const hash = sha256Bytes(body), files = readNpmTarball(body, hash, "dependency_tree");
  const manifest = files.find(file => file.path === "package.json");
  if (manifest === undefined) return undefined;

  const licenses = files.filter(file => /(^|\/)(?:licen[sc]e|copying|notice)(?:[.-][^/]*)?$/i.test(file.path))
    .map(file => ({ path: file.path, sha256: sha256Bytes(file.body) }));
  const base = { platform: "npm", name: pkg.name, version: pkg.version, scope, sha256: hash,
    manifestSha256: sha256Bytes(manifest.body), licenseSpdx: metadata.license, licenses };
  const repository = npmRepositoryClaim(metadata.repository);
  const revision = typeof metadata.gitHead === "string" && /^[a-f0-9]{40}$/.test(metadata.gitHead) ? metadata.gitHead : undefined;

  // Automated collection observes exact registry bytes. Publisher labels, even a gitHead,
  // never become a caller-reviewed repository pointer merely because acquisition was approved.
  return decodeNpmQuarantinePlan({ ...base, schemaVersion: 2, sourceIdentity: { kind: "registry_archive", archiveUrl: pkg.archiveUrl, integrity: pkg.integrity,
    ...(repository === undefined && revision === undefined ? {} : { claims: { kind: "publisher_claimed",
      ...(repository === undefined ? {} : { repository }), ...(revision === undefined ? {} : { revision }) } }) } });
}

function failure(code: string) {
  return { ok: false as const, code, message: "the selected npm closure could not produce a complete source-backed installation plan" };
}
