import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { ContentDomainFeedbackChange, ContentDomainFeedbackChangesReader } from "../learning-content/sources/domain-feedback.js";
import { readCentralOpenPurposeBindings } from "./runtime-purpose-memory.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";

type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

export const NATIVE_CHANGE_PREFIX = "central-runtime-native-change:";
export const nativeChangeReadRef = (change: ContentDomainFeedbackChange): string =>
  `${NATIVE_CHANGE_PREFIX}${contentHashOf(change)}`;

export function centralSourceReadScopes(scope: string, compatibleScopes: readonly string[] = []): ReadonlySet<string> {
  const scopes = new Set([scope, ...compatibleScopes]);
  if (scopes.size > 17 || [...scopes].some(value => !coordinationScopeValid(value) || value.length > 256)) {
    throw new Error("central_runtime_source_scope");
  }
  return scopes;
}

/** This validates only original-owner metadata. It never reads feedback bodies
 * or manufactures a revision from a Board sequence or projection payload. */
export function sourceNativeFeedbackChanges(board: BoardState, scope: string,
  reader: ContentDomainFeedbackChangesReader, compatibleScopes: readonly string[] = []): readonly ContentDomainFeedbackChange[] {
  const allowed = centralSourceReadScopes(scope, compatibleScopes);
  const result = new Map<string, ContentDomainFeedbackChange>();

  for (const change of reader(board, { scope })) {
    const issue = board.learningIssues?.find(row => row.issueId === change.issueId && allowed.has(row.scope));
    if (issue === undefined) continue;

    const owner = learningIssueOwner(issue);
    if ((owner === "method" ? "prompt" : owner) !== change.domain) throw new Error("central_runtime_native_change_owner");

    const ref = nativeChangeReadRef(change), previous = result.get(ref);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(change)) throw new Error("central_runtime_native_change_conflict");

    result.set(ref, change);
  }

  return [...result.values()];
}

/** Walk all bounded original metadata pages. A stopped open purpose is a
 * possible owner relation, never a new source or an automatically active goal. */
export function sourceOpenPurposeBindings(board: BoardState, scope: string): NonNullable<Query["purposes"]> {
  const entries: NonNullable<Query["purposes"]>[number][] = [];
  let offset = 0;

  for (;;) {
    const page = readCentralOpenPurposeBindings({ facts: board.rewardV2Facts ?? [], scope, boardSequence: board.sequence }, offset, 32);
    entries.push(...page.entries.map(row => ({ subject: row.subject, sourceRefs: row.sourceRefs, purpose: row.purpose })));
    if (page.nextOffset === null) return entries;
    if (page.nextOffset <= offset) throw new Error("central_runtime_native_archive_page");
    offset = page.nextOffset;
  }
}

/** Metadata navigation acknowledges a notice, never its fact/feedback body. */
export function nativeChangeCatalog(changes: readonly ContentDomainFeedbackChange[]): readonly CentralRuntimeMaterial[] {
  const materials: CentralRuntimeMaterial[] = [];
  let entries: (ContentDomainFeedbackChange & { readonly readRef: string })[] = [];
  const render = () => canonicalJson({ role: "original_native_feedback_change_catalog_not_read_body", entries });
  const flush = () => {
    if (entries.length === 0) return;
    const text = render();
    materials.push({ ref: `central-runtime-native-catalog:${contentHashOf(text)}`, kind: "feedback", text,
      sourceRefs: [...new Set(entries.flatMap(row => [row.revisionRef, row.factRef, row.issueId, row.unitRef]))] });
    entries = [];
  };

  for (const change of changes) {
    const row = { ...change, readRef: nativeChangeReadRef(change) };
    entries.push(row);
    if (entries.length > 16 || render().length > 32768) {
      entries.pop();
      flush();
      entries.push(row);
    }
    if (render().length > 32768) throw new Error("central_runtime_native_change_capacity");
  }

  flush();
  return materials;
}

export function nativeChangeDependencyMaterial(board: BoardState, change: ContentDomainFeedbackChange): CentralRuntimeMaterial | undefined {
  if (change.kind !== "approval" && change.kind !== "dependency") return undefined;

  const dependency = board.learningDependencies?.find(row => row.issueId === change.issueId && row.dependencyId === change.factRef);
  if (dependency === undefined) return undefined;

  if (change.revisionRef !== `${dependency.dependencyId}:revision:${dependency.revision}`
    || ![dependency.dependencyId, `dependency:${dependency.dependencyId}`].includes(change.unitRef)
    || dependency.state.kind === "waiting" || dependency.state.kind === "unavailable") return undefined;

  const issue = board.learningIssues?.find(row => row.issueId === dependency.issueId);
  const grant = board.centralLearningGrants?.find(row => row.grantId === dependency.grantId), job = board.jobs.find(row => row.jobId === dependency.jobId);
  if (issue === undefined || grant?.issueId !== issue.issueId || grant.scope !== issue.scope || grant.jobId !== dependency.jobId
    || (grant.domain ?? "collaboration") !== change.domain || job?.coordination?.issueId !== issue.issueId
    || job.coordination.grantId !== grant.grantId || job.domain !== change.domain || grant.focusRevision > issue.revision) return undefined;

  const text = canonicalJson({ role: "original_native_dependency_fact_not_verification", value: dependency });

  return { ref: `central-runtime-native-dependency:${contentHashOf(text)}`, kind: "feedback", text,
    sourceRefs: [...new Set([change.factRef, change.revisionRef, dependency.dependencyId, dependency.jobId, dependency.grantId])] };
}
