// Trylo Desktop — Artifact Promoter (renderer side).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 / §7.3 / §8.2.
//
// A browser package may only write process artifacts (downloads,
// screenshots, page dumps) into the conversation's RUNTIME TEMP dir:
// `<projectRoot>/.trylo/runtime/browser/<conversationId>` (§8.2 outputDir).
// That area is never a deliverable. `.trylo/out/` is the ONLY deliverable
// root (§7.3), and the promotion between the two is an explicit,
// user-driven step — never automatic — because process results must not
// masquerade as deliverables.
//
// The FS truth lives in the Service Host (`desktop-services/src/tooling/
// artifact-promoter.mjs`); this module is the renderer's typed handle and
// the one place that knows how to build a promotion request from a run
// scope. All path validation happens on the sidecar before any I/O.

import type { ToolingListRuntimeArtifactsResult, ToolingPromoteArtifactResult, ToolingRuntimeArtifact } from '../services-host/methods';
import type { ToolingFacade } from './tooling-facade';

/** The manifest's `runtimeDirName` for the browser package (§8.2). */
export const BROWSER_PACKAGE_ID = 'playwright';
export const BROWSER_RUNTIME_DIR_NAME = 'browser';

export type {
  ToolingRuntimeArtifact,
  ToolingListRuntimeArtifactsResult,
  ToolingPromoteArtifactResult,
};

export interface ArtifactPromotionScope {
  readonly projectRoot: string;
  readonly conversationId: string;
}

/**
 * List what the browser left in this conversation's runtime temp dir.
 * Resolves `null` on transport failure — listing is additive and must
 * never break a conversation view.
 */
export async function listBrowserRuntimeArtifacts(
  facade: ToolingFacade,
  scope: ArtifactPromotionScope,
): Promise<ToolingListRuntimeArtifactsResult | null> {
  return facade.listRuntimeArtifacts({
    projectRoot: scope.projectRoot,
    conversationId: scope.conversationId,
    packageId: BROWSER_PACKAGE_ID,
  });
}

/**
 * Promote ONE runtime temp artifact into `.trylo/out/`. The sidecar copies
 * (never moves), validates the path, dedupes the target name and returns
 * the promoted file's metadata (path + sha256) for the ResultDock.
 */
export async function promoteBrowserRuntimeArtifact(
  facade: ToolingFacade,
  scope: ArtifactPromotionScope,
  fileName: string,
  targetName?: string,
): Promise<ToolingPromoteArtifactResult> {
  return facade.promoteArtifact({
    projectRoot: scope.projectRoot,
    conversationId: scope.conversationId,
    packageId: BROWSER_PACKAGE_ID,
    fileName,
    ...(targetName ? { targetName } : {}),
  });
}
