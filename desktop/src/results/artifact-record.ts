import { artifactDisplayName, canonicalAbsolutePath, isHttpArtifact, relativeArtifactPath } from "./artifact-paths";
import { artifactCardKindFor } from "../preview/formats";
import { isOutputArtifactPath } from './output-files/eligibility';
import type { StoredFileSignature, StoredWorkArtifact, WorkArtifactSource, WorkArtifactTarget } from "./conversation-result-types";

export function signatureOf(a: StoredFileSignature | undefined): string {
  return a === undefined ? "" : `${a.size}:${a.modifiedMs}:${a.contentHash ?? ""}`;
}

/** Merge sources while keeping the fixed event → scan → recovery order
 *  (spec §8.5), so serialisation output is deterministic. */
export function orderedSources(prior: readonly WorkArtifactSource[] | undefined, next: WorkArtifactSource): readonly WorkArtifactSource[] {
  return (["event", "scan", "recovery"] as const).filter(
    (s) => s === next || (prior !== undefined && prior.includes(s)),
  );
}

/** Identity of an arbitrary artifact event path: an http(s) url stays the
 *  url; a file becomes its canonical relative path. Returns undefined when
 *  the value is not a usable target (kept out of the projection). */
export function targetFromInput(
  rawPath: string,
  projectRoot: string,
): { target: WorkArtifactTarget; displayName: string; absolutePath?: string } | undefined {
  const trimmed = rawPath.trim();
  if (isHttpArtifact(trimmed)) {
    return { target: { kind: "url", url: trimmed }, displayName: trimmed };
  }
  const canonical = canonicalAbsolutePath(trimmed);
  if (canonical === undefined) return undefined;
  const rel = relativeArtifactPath(canonical, projectRoot);
  if (rel === undefined || !isOutputArtifactPath(rel)) return undefined;
  return {
    target: { kind: "file", relativePath: rel },
    displayName: artifactDisplayName(canonical) || rel.split("/").pop() || rel,
    absolutePath: canonical,
  };
}

export function artifactKindFrom(hint: string | undefined, rel: string | undefined): StoredWorkArtifact['artifactKind'] {
  if (
    hint === "document" ||
    hint === "presentation" ||
    hint === "spreadsheet" ||
    hint === "web" ||
    hint === "file"
  ) {
    return hint;
  }
  return rel === undefined ? "file" : artifactCardKindFor(rel);
}
