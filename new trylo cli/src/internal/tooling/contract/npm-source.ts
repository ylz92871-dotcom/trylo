import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";

/** A caller-reviewed, exact-byte acquisition request. It grants no execution or activation. */
export type NpmQuarantinePlan = {
  readonly schemaVersion: 1;
  readonly platform: "npm";
  readonly name: string;
  readonly version: string;
  readonly scope: string;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly licenseSpdx: "MIT" | "ISC" | "BSD-2-Clause" | "BSD-3-Clause" | "0BSD" | "Apache-2.0";
  readonly upstreamUrl: string;
  readonly sourceRevision: string;
  readonly licenses: readonly { readonly path: string; readonly sha256: string }[];
};
const HASH = /^[a-f0-9]{64}$/;
const LICENSES: readonly string[] = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0"];

export function decodeNpmQuarantinePlan(value: unknown): NpmQuarantinePlan | undefined {
  if (!isJsonValue(value) || !recordOf(value) || !keysAre(value, ["schemaVersion", "platform", "name", "version", "scope", "sha256", "manifestSha256", "licenseSpdx", "upstreamUrl", "sourceRevision", "licenses"])
    || value.schemaVersion !== 1 || value.platform !== "npm" || typeof value.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[a-z0-9][a-z0-9._-]{0,80}$/.test(value.name)
    || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value.version) || value.version.length > 80
    || !textOf(value.scope, 160) || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256)
    || typeof value.licenseSpdx !== "string" || !LICENSES.includes(value.licenseSpdx)
    || typeof value.upstreamUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.upstreamUrl)
    || typeof value.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceRevision)
    || !Array.isArray(value.licenses) || value.licenses.length === 0 || value.licenses.length > 8) return undefined;
  const paths = new Set<string>();
  for (const item of value.licenses) {
    if (!recordOf(item) || !keysAre(item, ["path", "sha256"]) || typeof item.path !== "string" || !safePackagePath(item.path)
      || typeof item.sha256 !== "string" || !HASH.test(item.sha256) || paths.has(item.path.toLowerCase())) return undefined;
    paths.add(item.path.toLowerCase());
  }
  // The guard above is the persisted/external data boundary; return owned data only.
  return structuredClone(value) as NpmQuarantinePlan;
}

export function safePackagePath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".."
    && !/[\u0000-\u001f\u007f\\:<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}
export function quarantinePlanId(plan: NpmQuarantinePlan): string { return `npm-quarantine_v1_${contentHashOf(plan)}`; }
