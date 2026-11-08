import { contentHashOf } from "../../../../../control/hash.js";
import type { NpmToolProductionPlan } from "../../domain/evolution/npm-production-plan.js";
import type { PackageFile } from "./ustar-reader.js";

/** Previous implementation is a paged research document, never an additional installed dependency. */
export function npmLearningPrior(plan: NpmToolProductionPlan | undefined, prefix = "trylo_previous") {
  const files: PackageFile[] = [];

  if (plan === undefined) return { files, summary: undefined };

  const runtime = plan.runtime.profile !== "confined_npm_library_v1" ? plan.runtime : (() => {
    const sourcePath = `${prefix}/adapter.cjs`;
    files.push({ path: sourcePath, body: Buffer.from(plan.runtime.source) });
    return { profile: plan.runtime.profile, sourcePath, sourceContentHash: contentHashOf(plan.runtime.source) };
  })();
  const patches = (plan.patches ?? []).map((patch, index) => {
    const sourcePath = `${prefix}/patch-${index}.cjs`;
    files.push({ path: sourcePath, body: Buffer.from(patch.source) });
    return { path: patch.path, oldSha256: patch.oldSha256, sourcePath, sourceContentHash: contentHashOf(patch.source) };
  });

  return { files, summary: { descriptor: plan.candidate, runtime, patches } };
}
