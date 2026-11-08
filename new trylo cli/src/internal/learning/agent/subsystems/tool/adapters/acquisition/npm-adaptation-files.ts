import type { NpmToolProductionPlan } from "../../domain/evolution/npm-production-plan.js";
import { NPM_LIBRARY_ENTRYPOINT } from "../../domain/evolution/npm-adaptation.js";
import type { PackageFile } from "./ustar-reader.js";
import { sha256Bytes } from "./npm-package-check.js";

export class NpmAdaptationError extends Error {
  constructor(readonly code: "npm_patch_source_mismatch" | "npm_adapter_path_conflict") { super(code); }
}

/** Apply overlays to owned snapshot bytes only; original archives and receipts remain untouched.
 * License/NOTICE files are outside the patch ABI. Existing copyright/license comments are
 * retained and modified files carry an upstream hash even when the model omitted a notice. */
export function adaptNpmFiles(plan: NpmToolProductionPlan, files: readonly PackageFile[]): readonly PackageFile[] {
  const effective = new Map(files.map(file => [file.path, file]));

  for (const patch of plan.patches ?? []) {
    const original = effective.get(patch.path);
    if (original === undefined || sha256Bytes(original.body) !== patch.oldSha256) throw new NpmAdaptationError("npm_patch_source_mismatch");

    const prior = new TextDecoder("utf-8", { fatal: true }).decode(original.body);
    const preamble = prior.replace(/^#![^\r\n]*(?:\r?\n|$)/, "").match(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*/)?.[0] ?? "";
    const notices = [preamble, ...prior.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g)].map(match => typeof match === "string" ? match : match[0])
      .filter(comment => /copyright|licen[sc]e|spdx|@preserve/i.test(comment));
    const marker = `/* Modified by Trylo tool learning; upstream SHA-256: ${patch.oldSha256} */\n`;
    const header = [...new Set(notices)].filter(comment => !patch.source.includes(comment)).join("\n");
    const modification = `${header.length === 0 ? "" : `${header}\n`}${marker}`;
    const source = withModificationHeader(patch.source, modification);

    effective.set(patch.path, { path: patch.path, body: Buffer.from(source) });
  }

  if (plan.runtime.profile === "confined_npm_library_v1") {
    const file = `node_modules/${NPM_LIBRARY_ENTRYPOINT}`;
    if ([...effective.keys()].some(key => key.toLowerCase() === file.toLowerCase())) throw new NpmAdaptationError("npm_adapter_path_conflict");
    effective.set(file, { path: file, body: Buffer.from(plan.runtime.source) });
  }

  return [...effective.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function withModificationHeader(source: string, modification: string): string {
  const prefix = source.match(/^(?:\uFEFF)?(?:#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))?/)?.[0] ?? "";
  const shebang = prefix.startsWith("\uFEFF") ? prefix.slice(1) : prefix;
  const newline = shebang.startsWith("#!") && !/[\r\n\u2028\u2029]$/.test(prefix) ? "\n" : "";
  // Node rejects BOM+hashbang at byte zero. Keep the BOM as whitespace after
  // the first executable line in this derived snapshot, without changing the
  // canonical patch source or the reviewed installation bytes.
  const executablePrefix = prefix.startsWith("\uFEFF") && shebang.startsWith("#!") ? `${shebang}${newline}\uFEFF` : `${prefix}${newline}`;

  return `${executablePrefix}${modification}${source.slice(prefix.length)}`;
}
