import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { sha256Bytes } from "./npm-package-check.js";
import { planNpmLockedTree } from "./npm-tree-plan.js";
import type { NpmInstallPlan } from "../../tooling/contract/npm-install.js";
import type { NpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { isJsonValue, recordOf } from "../../learning/domains/tool/evolution/parse.js";

/** TEST ONLY deterministic archive encoder; it does not assert upstream provenance or license approval. */
export function npmTestTar(entries: readonly { readonly path: string; readonly text: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.text);
    header.write(`package/${entry.path}`, 0, 100); header.write("0000644\0", 100, 8); header.write("0000000\0", 108, 8); header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12); header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257, 6); header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export function npmTreeTestData(changes: { readonly root?: Record<string, unknown>; readonly leaf?: Record<string, unknown>; readonly leafFiles?: readonly { readonly path: string; readonly text: string }[] } = {}) {
  const bodies = new Map<string, Uint8Array>(), reviews: { location: string; review: NpmQuarantinePlan }[] = [];
  const packages: Record<string, object> = { "": { dependencies: { "test-cli": "1.0.0" } } };
  for (const [name, extra] of [["test-cli", { bin: "cli.cjs", dependencies: { leaf: "^1.0.0" }, ...changes.root }], ["leaf", changes.leaf ?? {}]] as const) {
    const manifest = { name, version: "1.0.0", license: "MIT", repository: `https://github.com/test-only/${name}`, ...extra };
    const text = JSON.stringify(manifest), license = "TEST ONLY license fixture", location = `node_modules/${name}`;
    const body = npmTestTar([{ path: "package.json", text }, { path: "LICENSE", text: license }, { path: "cli.cjs", text: "throw new Error('TEST ONLY: installation must not execute me');" }, ...(name === "leaf" ? changes.leafFiles ?? [] : [])]);
    const archiveUrl = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;
    packages[location] = { ...manifest, resolved: archiveUrl, integrity: `sha512-${createHash("sha512").update(body).digest("base64")}` };
    bodies.set(archiveUrl, body);
    reviews.push({ location, review: { schemaVersion: 1, platform: "npm", name, version: "1.0.0", scope: "test:install", sha256: sha256Bytes(body), manifestSha256: sha256Bytes(Buffer.from(text)),
      licenseSpdx: "MIT", upstreamUrl: `https://github.com/test-only/${name}`, sourceRevision: "a".repeat(40), licenses: [{ path: "LICENSE", sha256: sha256Bytes(Buffer.from(license)) }] } });
  }
  const lock = { lockfileVersion: 3, packages }, target = { os: "win32", cpu: "x64", nodeVersion: "24.11.1" };
  if (!isJsonValue(lock) || !recordOf(lock)) throw new Error("TEST ONLY invalid generated JSON lock");
  const planned = planNpmLockedTree({ scope: "test:install", name: "test-cli", version: "1.0.0", target, lock });
  if (!planned.ok) throw new Error(`TEST ONLY invalid closure fixture: ${planned.code}`);
  const plan: NpmInstallPlan = { type: "npm_install_plan", schemaVersion: 1, lock, tree: planned.tree, packages: reviews };
  return { plan, bodies, target };
}
