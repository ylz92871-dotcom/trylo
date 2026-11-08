import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonData, keysAre, recordOf, textOf } from "./json-value.js";

type NpmSourceReview = {
  readonly platform: "npm";
  readonly name: string;
  readonly version: string;
  readonly scope: string;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly licenseSpdx: "MIT" | "ISC" | "BSD-2-Clause" | "BSD-3-Clause" | "0BSD" | "Apache-2.0";
  readonly licenses: readonly { readonly path: string; readonly sha256: string }[];
};

/** Legacy caller-reviewed pointer. Its persisted fields and content identity remain unchanged. */
export type NpmGithubRevisionPlan = NpmSourceReview & {
  readonly schemaVersion: 1; readonly upstreamUrl: string; readonly sourceRevision: string;
};

export type NpmRegistrySourceIdentity = {
  readonly kind: "registry_archive"; readonly archiveUrl: string; readonly integrity: string;
  readonly claims?: { readonly kind: "publisher_claimed"; readonly repository?: string; readonly revision?: string };
};

/** Exact published source bytes do not require an invented repository commit or a model verdict. */
export type NpmRegistryArchivePlan = NpmSourceReview & { readonly schemaVersion: 2; readonly sourceIdentity: NpmRegistrySourceIdentity };

export type NpmQuarantinePlan = NpmGithubRevisionPlan | NpmRegistryArchivePlan;

const HASH = /^[a-f0-9]{64}$/;
const LICENSES: readonly string[] = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0"];

export function decodeNpmQuarantinePlan(value: unknown): NpmQuarantinePlan | undefined {
  if (!isJsonData(value, 16) || !recordOf(value) || value.platform !== "npm" || typeof value.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[a-z0-9][a-z0-9._-]{0,80}$/.test(value.name)
    || typeof value.version !== "string" || value.version.length > 80
    || !(value.schemaVersion === 1 ? /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/ : /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).test(value.version)
    || !textOf(value.scope, 160) || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256)
    || typeof value.licenseSpdx !== "string" || !LICENSES.includes(value.licenseSpdx)
    || !Array.isArray(value.licenses) || value.licenses.length === 0 || value.licenses.length > 8) return undefined;

  const baseKeys = ["schemaVersion", "platform", "name", "version", "scope", "sha256", "manifestSha256", "licenseSpdx", "licenses"];

  if (value.schemaVersion === 1) {
    if (!keysAre(value, [...baseKeys, "upstreamUrl", "sourceRevision"]) || typeof value.upstreamUrl !== "string"
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.upstreamUrl)
      || typeof value.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceRevision)) return undefined;
  } else if (value.schemaVersion !== 2 || !keysAre(value, [...baseKeys, "sourceIdentity"])
    || !registrySourceIdentity(value.sourceIdentity, value.name, value.version)) return undefined;

  const paths = new Set<string>();

  for (const item of value.licenses) {
    if (!recordOf(item) || !keysAre(item, ["path", "sha256"]) || typeof item.path !== "string" || !safePackagePath(item.path)
      || typeof item.sha256 !== "string" || !HASH.test(item.sha256) || paths.has(item.path.toLowerCase())) return undefined;
    paths.add(item.path.toLowerCase());
  }

  // The guard above is the persisted/external data boundary; return owned data only.
  return structuredClone(value) as NpmQuarantinePlan;
}

function registrySourceIdentity(raw: unknown, name: string, version: string): raw is NpmRegistrySourceIdentity {
  if (!recordOf(raw) || !keysAre(raw, ["kind", "archiveUrl", "integrity"], ["claims"]) || raw.kind !== "registry_archive"
    || raw.archiveUrl !== npmRegistryArchiveUrl(name, version) || !isNpmSha512Integrity(raw.integrity)) return false;

  if (raw.claims === undefined) return true;

  const claims = raw.claims;

  return recordOf(claims) && keysAre(claims, ["kind"], ["repository", "revision"]) && claims.kind === "publisher_claimed"
    && (claims.repository !== undefined || claims.revision !== undefined)
    && (claims.repository === undefined || isNpmRepositoryClaim(claims.repository))
    && (claims.revision === undefined || typeof claims.revision === "string" && /^[a-f0-9]{40}$/.test(claims.revision));
}

export function isNpmRepositoryClaim(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 1024) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.href === raw && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === "" && url.pathname !== "/";
  } catch { return false; }
}

export function isNpmSha512Integrity(raw: unknown): raw is string {
  return typeof raw === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(raw)
    && Buffer.from(raw.slice(7), "base64").toString("base64") === raw.slice(7);
}

export function npmRegistryArchiveUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}

export function npmSourceRepository(plan: NpmQuarantinePlan): string | undefined {
  return plan.schemaVersion === 1 ? plan.upstreamUrl : plan.sourceIdentity.claims?.repository;
}

export function safePackagePath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".."
    && !/[\u0000-\u001f\u007f\\:<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function quarantinePlanId(plan: NpmQuarantinePlan): string { return `npm-quarantine_v${plan.schemaVersion}_${contentHashOf(plan)}`; }
