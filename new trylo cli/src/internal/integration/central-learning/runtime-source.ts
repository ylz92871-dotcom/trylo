import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { CentralSingleActionVersion } from "./change-single-action-version.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningOpportunity, CentralLearningSubject, CentralRuntimeMaterial, CentralRuntimeSnapshot, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { CONTENT_ALGORITHM, readContentRecords } from "../learning-content/records.js";
import { isContentDataSafe, isContentValueCredentialSafe } from "../learning-content/content-confidentiality.js";
import { canReadNativeAsset, canReadNativeContentRecord } from "../learning-content/sources/native-knowledge.js";
import { isContentDomainFeedback, readDomainFeedbackMaterial, MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS, type ContentDomainFeedbackReader,
  type ContentDomainFeedbackChangesReader } from "../learning-content/sources/domain-feedback.js";
import type { TaskSourcePageReader } from "../learning-content/task-source-pages.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import { lookupCentralRuntimeRecord, type CentralRuntimeLookup } from "../../learning/central/runtime/records.js";
import { readCentralMethodResearchMaterial } from "./research-intake-method.js";
import { readCentralPurposeMemory, recallCentralPurposeMaterials } from "./runtime-purpose-memory.js";
import { centralNativeSourceRelations } from "./runtime-source-native.js";
import { readCentralOrganizationMemory } from "./runtime-organization-memory.js";
import { centralMaterialFromPage, readCentralMaterialPageRef } from "./deliberation-material.js";
import { nativeChangeCatalog, nativeChangeReadRef, nativeChangeDependencyMaterial, NATIVE_CHANGE_PREFIX,
  sourceNativeFeedbackChanges, sourceOpenPurposeBindings, centralSourceReadScopes } from "./runtime-source-changes.js";
import { readOrganizationNativeFeedbackUnit } from "./organization-feedback-sources.js";
import { createRuntimeSourceFrames, PUBLIC_SOURCE_BODY_PREFIX } from "./runtime-source-frames.js";
import { createNativeExposureAttention, isNativeExposureAttentionRef } from "./runtime-source-attention.js";
import { centralIssueSourceRefs, isConsideredCentralIssueNotice } from "./runtime-source-issue-refs.js";
import { createActivePurposeSourceReader } from "./active-purpose-source.js";
import { centralAgentResearchCapabilities } from "./runtime-agent-capabilities.js";
import { centralRuntimeEnvironmentCondition } from "./runtime-environment-condition.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { centralBusinessSourceBodyNotice } from "./deliberation-business-sources.js";
import { readCentralAdvisoryFeedback } from "./runtime-central-advisory-feedback.js";
import { latestCentralBudgetChangeSource } from "./runtime-budget-source.js";

export interface CentralRuntimeSourceOptions {
  readonly boardRoot: string;
  readonly scope: string;
  /** Host-proven read aliases only. Nomination and opportunities stay primary. */
  readonly compatibleScopes?: readonly string[];
  readonly readCompatibleScopes?: () => readonly string[];
  readonly board?: Pick<BoardStore, "load">;
  readonly ports: readonly CentralLearningExecutionPort[];
  readonly enabled: () => boolean;
  /** The host's resolved, persisted connection; never a business turn override. */
  readonly providerConnection?: { readonly providerId: string; readonly model: string; readonly providerConnectionRef: string;
    readonly decisionFormat?: "action_tool" | "action_json"; readonly decisionVersion?: CentralSingleActionVersion };
  readonly domainFeedback?: ContentDomainFeedbackReader;
  readonly nativeFeedbackChanges?: ContentDomainFeedbackChangesReader;
  readonly pageReader?: TaskSourcePageReader;
  /** Peers keep their original source identities. Ownership is explicit, never a User prefix guess. */
  readonly peerSources?: readonly (CentralRuntimeSourcePort & {
    readonly owns?: (scope: string, ref: string) => boolean | Promise<boolean>;
  })[];
  /** Read contracts from the peers actually mounted by this host. */
  readonly peerReadContracts?: readonly string[];
  readonly maximumSnapshotChars?: number;
  readonly secrets?: readonly string[];
}

export class CentralRuntimeSourceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CentralRuntimeSourceError";
  }
}

class FragmentCapacityError extends CentralRuntimeSourceError {
  constructor() { super("central_runtime_source_capacity"); }
}

const fail = (reason: string): never => { throw new CentralRuntimeSourceError(reason); };
const PAGE_PREFIX = "central-runtime-page:";

type RuntimeSourceQuery = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

const pageRef = (ref: string, start: number) => `${PAGE_PREFIX}${start}:${encodeURIComponent(ref)}`;

function address(ref: string) {
  const sourcePage = readCentralMaterialPageRef(ref);
  if (sourcePage !== undefined) return sourcePage;

  if (!ref.startsWith(PAGE_PREFIX)) return { ref, start: 0 };

  const match = /^central-runtime-page:(\d+):(.+)$/.exec(ref);
  if (match === null) return fail("central_runtime_source_page_invalid");

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return fail("central_runtime_source_page_invalid");

  try { return { ref: decodeURIComponent(match[2]!), start }; }
  catch { return fail("central_runtime_source_page_invalid"); }
}

/** Read adapters own no business session, funds, issue decisions or asset writes.
 * A page is a fragment with its own identity, never the complete original source. */
export function createCentralRuntimeSource(options: CentralRuntimeSourceOptions): CentralRuntimeSourcePort {
  const maximum = options.maximumSnapshotChars ?? 60000;
  if (!Number.isSafeInteger(maximum) || maximum < 2048 || maximum > 100000) fail("central_runtime_source_capacity");

  const board = options.board ?? createBoardReader(options.boardRoot);
  const scopeSnapshot = () => centralSourceReadScopes(options.scope, [...(options.readCompatibleScopes?.() ?? options.compatibleScopes ?? [])]);
  const sourceFrames = createRuntimeSourceFrames({ boardRoot: options.boardRoot, scope: options.scope,
    compatibleScopes: options.compatibleScopes ?? [], enabled: options.enabled, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
  const peerReferences = new Map<CentralRuntimeSourcePort, Set<string>>();
  const connectionText = options.providerConnection === undefined ? undefined : canonicalJson({
    role: "actual_provider_connection_not_business_evidence", scope: options.scope, ...options.providerConnection });
  const connectionMaterial: CentralRuntimeMaterial | undefined = connectionText === undefined ? undefined : {
    ref: `central-runtime-constraint:${contentHashOf(connectionText)}`, kind: "source", text: connectionText, sourceRefs: [] };
  const check = (scope: string, signal: AbortSignal) => {
    if (scope !== options.scope) fail("central_runtime_source_scope");
    if (signal.aborted) fail("central_runtime_source_cancelled");
    if (!options.enabled()) fail("collect_disabled");
  };
  const load = async (scope: string, signal: AbortSignal) => {
    check(scope, signal);
    const loaded = await board.load();
    check(scope, signal);
    if (!loaded.ok) return fail(loaded.reason);
    return loaded.state;
  };
  const readFeedback = async (state: BoardState, issue: LearningIssue, signal: AbortSignal) => {
    check(options.scope, signal);
    const owner = learningIssueOwner(issue);
    if (options.domainFeedback === undefined || owner === "ambiguous") return undefined;

    const result = await readDomainFeedbackMaterial({ board: state, scope: issue.scope,
      domain: owner === "method" ? "prompt" : owner, issueIds: [issue.issueId], domainFeedback: async (board, issueId) => {
        const frame = await options.domainFeedback!(board, issueId);
        // The current collaboration producer always emits this interpretation
        // header. Without a version/use/source fact it establishes no feedback.
        return owner === "collaboration" && isContentDomainFeedback(frame) && frame.sourceRefs.length === 0
          && frame.records.every(row => row.schema === "collaboration-central-followup/v1"
            && Object.keys(row).every(key => ["schema", "issueId", "interpretation"].includes(key))) ? undefined : frame;
      },

      // This prepares original-owner provenance for a catalog and exact reads;
      // it is not a model delivery. Keep the existing protocol envelope here.
      signal, maximumChars: MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });

    check(options.scope, signal);

    if (!result.ok) return fail(result.reason);

    return result.value;
  };

  return {
    async snapshot(scope, signal, query?: RuntimeSourceQuery) {
      check(scope, signal);
      const readScopes = scopeSnapshot(), compatibleScopes = [...readScopes].filter(value => value !== scope);

      for (const port of options.ports) {
        await port.nominate?.(signal);
        check(scope, signal);
      }

      // Read the Board after nominations so the snapshot includes their committed facts.
      const state = await load(scope, signal), issues = localIssues(state, readScopes);
      const known = new Set(query?.sourceRefs ?? []);
      const considered = new Set(query?.consideredSourceRefs ?? []);
      const originalChanges = options.nativeFeedbackChanges === undefined ? undefined : sourceNativeFeedbackChanges(state, scope, options.nativeFeedbackChanges, compatibleScopes);
      const attention = originalChanges === undefined ? undefined : createNativeExposureAttention(state, scope, originalChanges, query, compatibleScopes);
      const relationQuery = attention?.query ?? query;
      const active = centralNativeSourceRelations(state, scope, issues, relationQuery, compatibleScopes, options.secrets);
      const changes = attention?.changes;
      const unknown = changes?.filter(change => !known.has(change.revisionRef)) ?? [];
      const native = unknown.length === 0 ? active : centralNativeSourceRelations(state, scope, issues, {
        subjects: relationQuery?.subjects ?? [], sourceRefs: relationQuery?.sourceRefs ?? [],
        purposes: [...(relationQuery?.purposes ?? []), ...sourceOpenPurposeBindings(state, scope)],
      }, compatibleScopes, options.secrets);
      const changed = unknown.filter(change => native.subjectsByIssue.has(change.issueId));
      const changedIds = new Set(changed.map(change => change.issueId));
      const related = [...issues.filter(issue => changedIds.has(issue.issueId)),
        ...issues.filter(issue => !changedIds.has(issue.issueId) && active.subjectsByIssue.has(issue.issueId))];
      // Discover a bounded original report catalog. No content products/assets are
      // decoded and no unrelated issue's feedback reader is called here.
      const fresh = issues.filter(issue => !native.handoffs.has(issue.issueId) && !related.includes(issue)
        && !known.has(issueNoticeRef(issue)) && !isConsideredCentralIssueNotice(issueNoticeRef(issue), considered)).slice(0, 32);
      // PA may focus a report the central model previously considered without
      // opening a purpose. Its unchanged report digest is still old evidence;
      // the new governance decision must nevertheless reach that model.
      const focusedChanges = issues.filter(issue => issue.scope === scope && issue.decision.kind === "focused_learning"
        && !known.has(issueConstraint(issue).ref));
      const shown = [...new Set([...related.slice(0, 32), ...focusedChanges.slice(0, 32), ...fresh])];
      const catalog = issueCatalog(issues, shown, Math.max(0, ...fresh.map(issue => issues.indexOf(issue) + 1)), native.handoffs);

      safe(catalog, options);
      const environment = centralRuntimeEnvironmentCondition(options.ports, options.peerReadContracts ?? []);
      const budgetChange = latestCentralBudgetChangeSource(state, scope);
      const materials: CentralRuntimeMaterial[] = [centralAgentResearchCapabilities(options.ports), environment,
        ...(connectionMaterial === undefined ? [] : [connectionMaterial]),
        ...(budgetChange === undefined ? [] : [budgetChange.material]), catalog, ...nativeChangeCatalog(changed),
        ...attention?.navigation(shown.map(issue => issue.issueId)) ?? []];
      if (!isContentValueCredentialSafe(materials, options.secrets ?? [])) return fail("central_runtime_source_sensitive");

      const reconsider: NonNullable<CentralRuntimeSnapshot["reconsider"]>[number][] = [];

      for (const change of changed) for (const subject of native.subjectsByIssue.get(change.issueId) ?? []) {
        reconsider.push({ subject, sourceRefs: [change.revisionRef], reason: `original_native_${change.kind}_changed` });
      }

      for (const issue of shown) {
        materials.push(issueConstraint(issue));
      }

      const actualRefs = [environment.ref, ...(connectionMaterial === undefined ? [] : [connectionMaterial.ref]),
        ...(budgetChange === undefined ? [] : [budgetChange.sourceRef]),
        ...focusedChanges.map(issue => issueConstraint(issue).ref),
        ...shown.filter(issue => !native.handoffs.has(issue.issueId)).map(issueNoticeRef), ...changed.map(change => change.revisionRef)];

      for (const issue of focusedChanges) {
        const ref = issueConstraint(issue).ref;
        reconsider.push(...(native.subjectsByIssue.get(issue.issueId) ?? []).map(subject => ({ subject, sourceRefs: [ref],
          reason: "PA_current_focused_constraint_requires_review" })));
      }

      // A native result reference is not its body. Supply the selected purpose's
      // original method records through the existing bounded material/page path.
      const researchRefs = [...new Set((query?.purposes ?? []).flatMap(purpose => purpose.sourceRefs))]
        .filter(ref => ref.startsWith("method-research-record:")).slice(0, 8);

      for (const ref of researchRefs) {
        const material = exactBoardMaterial(state, issues, ref, options);
        if (material === undefined) continue;
        // The native method record may exceed one public material. Apply the
        // existing lossless page transport before purpose/provenance projection;
        // the later whole-snapshot cap cannot repair an oversized input there.
        materials.push(fragment(material, 0, Math.min(32768, maximum)));
        actualRefs.push(material.ref);
      }

      for (const issue of related.slice(0, 32)) {
        const subjects = native.subjectsByIssue.get(issue.issueId) ?? [];

        if (issue.decision.kind === "ordinary_execution" || issue.decision.kind === "resolved") {
          const text = canonicalJson({ role: "PA_current_constraint_not_business_evidence", issueId: issue.issueId, decision: issue.decision });
          const ref = `central-runtime-constraint:${contentHashOf(text)}`;
          actualRefs.push(ref);
          if (!known.has(ref)) reconsider.push(...subjects.map(subject => ({ subject, sourceRefs: [ref], reason: "PA_current_ordinary_or_resolved_constraint_requires_review" })));
        }

        if (!native.handoffs.has(issue.issueId) && !known.has(issueNoticeRef(issue))) {
          reconsider.push(...subjects.map(subject => ({ subject, sourceRefs: [issueNoticeRef(issue)], reason: "original_report_catalog_changed" })));
        }

        if (changes !== undefined && !changedIds.has(issue.issueId)) continue;

        for (const dependency of state.learningDependencies?.filter(row => row.issueId === issue.issueId
          && row.state.kind !== "waiting" && row.state.kind !== "unavailable") ?? []) {
          const text = canonicalJson({ role: "native_dependency_condition_not_new_business_evidence", dependencyId: dependency.dependencyId,
            owner: dependency.owner, state: dependency.state, requestId: dependency.requestId ?? null });
          const ref = `central-runtime-native-condition:${contentHashOf(text)}`;

          if (!isContentValueCredentialSafe(text, options.secrets ?? [])) return fail("central_runtime_source_sensitive");

          materials.push({ ref, kind: "feedback", text, sourceRefs: [dependency.dependencyId, dependency.grantId, dependency.jobId] });

          if (changes === undefined) {
            actualRefs.push(ref);
            if (!known.has(ref)) reconsider.push(...subjects.map(subject => ({ subject, sourceRefs: [ref], reason: "original_native_dependency_condition_changed" })));
          }
        }

        const feedback = await readFeedback(state, issue, signal);
        if (feedback === undefined) continue;

        for (const frame of feedback.coverage.frames) {
          const ref = feedbackBodyRef(issue.issueId, frame.sourceHash);
          const text = canonicalJson({ role: "original_domain_feedback_catalog_not_read_body", readRef: ref,
            sourceRef: frame.ref, sourceHash: frame.sourceHash, totalChars: frame.totalChars });
          const catalogRef = `central-runtime-domain-catalog:${contentHashOf(text)}`;

          materials.push({ ref: catalogRef, kind: "feedback", text, sourceRefs: [ref, frame.ref, issue.issueId] });

          if (changes === undefined) {
            actualRefs.push(catalogRef);
            if (!known.has(catalogRef)) reconsider.push(...subjects.map(subject => ({ subject, sourceRefs: [catalogRef], reason: "related_owner_feedback_changed_or_not_yet_read" })));
          }
        }
      }

      const peerSnapshots = await Promise.all((options.peerSources ?? []).map(peer => peer.snapshot(scope, signal, query)));

      check(scope, signal);
      const opportunities = shown.filter(issue => issue.scope === scope && !native.handoffs.has(issue.issueId)).flatMap(issue => opportunity(issue));

      for (let index = 0; index < peerSnapshots.length; index += 1) {
        const peer = peerSnapshots[index]!, owner = options.peerSources![index]!;
        peerReferences.set(owner, new Set([...peer.sourceRefs, ...peer.materials.flatMap(item => [item.ref, ...item.sourceRefs]),
          ...peer.opportunities.flatMap(item => [item.sourceRef, ...(item.subject.plane === "user"
            ? [item.subject.ledgerRef, item.subject.questionRef] : item.subject.plane === "agent" ? [item.subject.issueId] : [item.subject.questionRef])])]));
        opportunities.push(...peer.opportunities.filter(item => !opportunities.some(known => canonicalJson(known.subject) === canonicalJson(item.subject))));
      }

      const peerMaterials = peerSnapshots.flatMap(peer => peer.materials);
      const peerNotices = new Set(peerSnapshots.flatMap(peer => peer.sourceRefs).filter(ref => ref.startsWith("central-business-turn:")));
      const freshHandoffs = peerMaterials.filter(material => material.ref.startsWith("central-source-page:")
        && peerNotices.has(centralBusinessSourceBodyNotice(material, peerMaterials) ?? ""));
      const freshDirectories = peerMaterials.filter(material => material.ref.startsWith("central-business-catalog:")
        && material.sourceRefs.some(ref => peerNotices.has(ref)));
      const freshDirectoryRefs = new Set(freshDirectories.map(material => material.ref));
      const freshHandoffRefs = new Set(freshHandoffs.map(material => material.ref));
      const handoffGroups = freshDirectories.flatMap(directory => [directory, ...freshHandoffs
        .filter(material => centralBusinessSourceBodyNotice(material, [directory]) !== undefined)]);
      // Keep governance controls, then current returned business text, ahead of
      // old purpose background before this source's own capacity projection.
      const peerReconsider = peerSnapshots.flatMap(peer => peer.reconsider ?? []);
      const front = distinct([...materials.filter(isCentralUnreadNavigationMaterial), ...handoffGroups]);
      const feedbackCapacity = Math.min(12000, maximum - bounded(front, maximum).reduce((sum, material) => sum + material.text.length, 0));
      const advisoryFeedback = readCentralAdvisoryFeedback(state, scope,
        [...(query?.wakeSourceRefs ?? []), ...peerReconsider.flatMap(change => change.sourceRefs)], query?.sourceRefs, feedbackCapacity,
        query?.purposes?.flatMap(purpose => purpose.sourceRefs) ?? []);

      for (const material of advisoryFeedback.materials) if (!isContentValueCredentialSafe(material, options.secrets ?? [])) return fail("central_runtime_source_sensitive");

      actualRefs.push(...advisoryFeedback.sourceRefs);
      reconsider.push(...advisoryFeedback.reconsider);
      const allMaterials = distinct([...front, ...advisoryFeedback.materials, ...materials, ...peerMaterials]);
      const remembered = recallCentralPurposeMaterials({ facts: state.rewardV2Facts ?? [], scope, boardSequence: state.sequence,
        subjects: [...(query?.subjects ?? []), ...reconsider.map(change => change.subject)],
        ...(query?.purposes === undefined ? {} : { purposes: query.purposes }),
        materials: allMaterials });

      for (const material of remembered) {
        if (!isContentValueCredentialSafe(material, options.secrets ?? [])) return fail("central_runtime_source_sensitive");
        allMaterials.push(material);
      }

      const projected = bounded(allMaterials, maximum);
      const projectedDirectories = new Set(projected.filter(material => freshDirectoryRefs.has(material.ref))
        .flatMap(material => material.sourceRefs.filter(ref => peerNotices.has(ref))));
      // A notice-bound result without its verified directory cannot silently
      // lose its trigger/priority association under this earlier capacity cap.
      const exposed = projected.filter(material => !freshHandoffRefs.has(material.ref)
        || projectedDirectories.has(centralBusinessSourceBodyNotice(material, freshDirectories) ?? ""));
      // A capacity manifest exposes an address, not the notice/catalog body.
      // Only complete original material (or an actual opportunity) proves exposure.
      const original = new Map(allMaterials.map(material => [material.ref, material]));
      const visible = new Set(exposed.filter(material => original.get(material.ref)?.text === material.text)
        .flatMap(item => [item.ref, ...item.sourceRefs]));
      const peerOpportunityRefs = new Set(peerSnapshots.flatMap(peer => peer.opportunities.map(item => item.sourceRef)));
      const consumedHere = [...new Set([...actualRefs.filter(ref => visible.has(ref)),
        ...peerSnapshots.flatMap(peer => peer.sourceRefs).filter(ref => visible.has(ref) || peerOpportunityRefs.has(ref))])];
      const hasMore = advisoryFeedback.hasMore || peerSnapshots.some(peer => peer.hasMore === true)
        || issues.some(issue => !native.handoffs.has(issue.issueId) && !known.has(issueNoticeRef(issue))
          && !isConsideredCentralIssueNotice(issueNoticeRef(issue), considered) && !consumedHere.includes(issueNoticeRef(issue)))
        || [...actualRefs, ...peerSnapshots.flatMap(peer => peer.sourceRefs)].some(ref => !known.has(ref)
          && !isConsideredCentralIssueNotice(ref, considered) && !consumedHere.includes(ref));
      const providerPositiveNotes = [...new Map(peerSnapshots.flatMap(peer => peer.providerPositiveNotes ?? []).map(note => [note.ref, note])).values()]
        .sort((left, right) => Date.parse(right.finish.at) - Date.parse(left.finish.at)
          || right.finish.sequence - left.finish.sequence || left.ref.localeCompare(right.ref)).slice(0, 8);

      return { boardSequence: state.sequence, opportunities, materials: exposed, providerPositiveNotes,
        hasMore,
        reconsider: [...reconsider, ...peerReconsider]
          .filter(change => change.sourceRefs.every(ref => visible.has(ref))),
        sourceRefs: consumedHere };
    },

    async read(scope, refs, maximumChars, signal) {
      check(scope, signal);
      const readScopes = scopeSnapshot(), compatibleScopes = [...readScopes].filter(value => value !== scope);

      if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000 || refs.length > 64) {
        return fail("central_runtime_source_capacity");
      }

      let state: BoardState | undefined;
      let activePurposeReader: ReturnType<typeof createActivePurposeSourceReader> | undefined;
      const selected: CentralRuntimeMaterial[] = [];
      let remaining = maximumChars;

      try {
        for (const requested of [...new Set(refs)]) {
          check(scope, signal);
          if (remaining === 0) break;

          const target = address(requested);
          if (connectionMaterial !== undefined && target.ref === connectionMaterial.ref) {
            safe(connectionMaterial, options);
            const material = fragment(connectionMaterial, target.start, Math.min(32768, remaining));
            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          state ??= await load(scope, signal);
          activePurposeReader ??= createActivePurposeSourceReader(state, scope);
          const activePurpose = activePurposeReader(target.ref);
          if (activePurpose.status !== "unhandled") {
            if (activePurpose.status === "missing") return fail("central_runtime_source_missing");

            // The reader rebuilt this body from the verified same-scope chain.
            // Check its prose unchanged, while treating only its own canonical
            // scope slot like the validated scope slot in other native packets.
            const body: unknown = JSON.parse(activePurpose.material.text);
            if (typeof body !== "object" || body === null || Array.isArray(body)
              || !("scope" in body) || body.scope !== scope) return fail("central_runtime_source_sensitive");

            safe({ ...activePurpose.material, text: canonicalJson({ ...body, scope: "[canonical_scope]" }) }, options);
            const material = fragment(activePurpose.material, target.start, Math.min(32768, remaining));

            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          const archived = lookupCentralRuntimeRecord(state.rewardV2Facts ?? [], scope, state.sequence, { kind: "material", ref: target.ref });
          if (archived.status === "found" && "ref" in archived.value && "text" in archived.value) {
            if (target.ref.startsWith(PUBLIC_SOURCE_BODY_PREFIX)) {
              const frozen = await sourceFrames.read(target.ref, state, signal);
              if (frozen === undefined || frozen.text !== archived.value.text) return fail("central_runtime_source_frame_identity");
            }

            if (!isContentValueCredentialSafe(archived.value, options.secrets ?? [])) return fail("central_runtime_source_sensitive");

            const material = fragment(archived.value, target.start, Math.min(32768, remaining));

            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          const budgetChange = latestCentralBudgetChangeSource(state, scope);
          if (budgetChange !== undefined && (target.ref === budgetChange.sourceRef || target.ref === budgetChange.material.ref)) {
            safe(budgetChange.material, options);
            const material = fragment(budgetChange.material, target.start, Math.min(32768, remaining));
            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          if (isNativeExposureAttentionRef(target.ref)) {
            const changes = options.nativeFeedbackChanges === undefined ? []
              : sourceNativeFeedbackChanges(state, scope, options.nativeFeedbackChanges, compatibleScopes);
            const original = createNativeExposureAttention(state, scope, changes, undefined, compatibleScopes).read(target.ref);
            if (original === undefined) return fail("central_runtime_source_missing");

            safe(original, options);
            const material = fragment(original, target.start, Math.min(32768, remaining));

            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          if (target.ref.startsWith(PUBLIC_SOURCE_BODY_PREFIX)) {
            const original = await sourceFrames.read(target.ref, state, signal);
            check(scope, signal);
            if (original === undefined) return fail("central_runtime_source_missing");
            const material = fragment(original, target.start, Math.min(8192, remaining));
            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          if (target.ref.startsWith(NATIVE_CHANGE_PREFIX)) {
            const change = options.nativeFeedbackChanges === undefined ? undefined
              : sourceNativeFeedbackChanges(state, scope, options.nativeFeedbackChanges, compatibleScopes).find(row => nativeChangeReadRef(row) === target.ref);
            if (change === undefined) return fail("central_runtime_source_missing");

            const issue = localIssues(state, readScopes).find(row => row.issueId === change.issueId);
            if (issue === undefined) return fail("central_runtime_source_missing");

            const raw = await options.domainFeedback?.(state, issue.issueId);
            check(scope, signal);

            if (raw !== undefined && !isContentDomainFeedback(raw)) return fail("content_domain_feedback_transport_gap");

            const unit = readOrganizationNativeFeedbackUnit(raw, change);
            if (unit.kind === "found") {
              const original = await sourceFrames.unit(issue, change, unit, signal, compatibleScopes);
              check(scope, signal);
              const material = fragment(original, target.start, Math.min(8192, remaining));
              selected.push(material);
              remaining -= material.text.length;
              continue;
            }

            const dependency = nativeChangeDependencyMaterial(state, change);
            if (dependency !== undefined) {
              const original = await sourceFrames.dependency(issue, dependency, signal, compatibleScopes);
              check(scope, signal);
              const material = fragment(original, target.start, Math.min(8192, remaining));
              selected.push(material);
              remaining -= material.text.length;
              continue;
            }

            if (unit.kind === "missing") return fail("central_runtime_source_missing");

            const owner = await readFeedback(state, issue, signal), frame = owner?.coverage.frames[0];
            if (owner === undefined || frame === undefined) return fail("central_runtime_source_missing");

            if (owner.coverage.frames.length !== 1) return fail("central_runtime_source_ambiguous");

            const original = await sourceFrames.owner(issue, owner, frame, signal, compatibleScopes);
            check(scope, signal);
            const material = fragment(original, target.start, Math.min(8192, remaining));

            selected.push(material);
            remaining -= material.text.length;
            continue;
          }

          const organization = await readCentralOrganizationMemory({ boardRoot: options.boardRoot, scope,
            enabled: options.enabled, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) }, target.ref, signal, remaining);

          check(scope, signal);

          if (organization !== undefined) {
            if (target.start !== 0) return fail("central_organization_packet_fragment_not_supported");
            const size = organization.reduce((sum, material) => sum + material.text.length, 0);
            if (size > remaining) return fail("central_runtime_source_capacity");
            if (!isContentValueCredentialSafe(organization, options.secrets ?? [])) return fail("central_runtime_source_sensitive");
            selected.push(...organization);
            remaining -= size;
            continue;
          }

          const peers = [];

          for (const peer of options.peerSources ?? []) {
            if (peer.owns === undefined ? peerReferences.get(peer)?.has(target.ref) === true : await peer.owns(scope, target.ref)) peers.push(peer);
          }

          check(scope, signal);

          if (peers.length > 1) return fail("central_runtime_source_ambiguous");

          if (peers.length === 1) {
            const rows = await peers[0]!.read(scope, [requested], remaining, signal);
            check(scope, signal);
            const size = rows.reduce((sum, row) => sum + row.text.length, 0);
            if (size > remaining) return fail("central_runtime_source_capacity");
            if (rows.length === 0) return fail("central_runtime_source_missing");
            selected.push(...rows);
            remaining -= size;
            continue;
          }

          const issues = localIssues(state, readScopes);
          const found = exactBoardMaterial(state, issues, target.ref, { ...options, compatibleScopes });
          if (found !== undefined) {
            const result = fragment(found, target.start, Math.min(32768, remaining));
            selected.push(result);
            remaining -= result.text.length;
            continue;
          }

          let resolved = false;
          const feedbackIssue = issues.find(issue => target.ref.startsWith(`central-runtime-domain:${encodeURIComponent(issue.issueId)}:`)
            || target.ref.startsWith(`central-runtime-domain-body:${encodeURIComponent(issue.issueId)}:`));
          if (feedbackIssue !== undefined) {
            const owner = await readFeedback(state, feedbackIssue, signal);
            const frame = owner?.coverage.frames.find(row => feedbackRef(feedbackIssue.issueId, row.sourceHash) === target.ref
              || feedbackBodyRef(feedbackIssue.issueId, row.sourceHash) === target.ref);
            if (frame === undefined || owner === undefined) return fail("central_runtime_source_missing");

            const original = await sourceFrames.owner(feedbackIssue, owner, frame, signal, compatibleScopes);
            check(scope, signal);
            const material = fragment(original, target.start, Math.min(8192, remaining));

            selected.push(material);
            remaining -= material.text.length;
            resolved = true;
          }

          if (resolved) continue;

          if (options.pageReader !== undefined) {
            const page = await options.pageReader.read(target.ref, signal, target.start, Math.min(8192, remaining));

            check(scope, signal);

            if (page.ok) {
              if (!readScopes.has(page.value.originalScope)) fail("central_runtime_source_scope");
              const original = centralMaterialFromPage(page.value);
              if (!isContentValueCredentialSafe(original, options.secrets ?? [])) return fail("central_runtime_source_sensitive");
              const material = fragment(original, 0, Math.min(32768, remaining));
              selected.push(material);
              remaining -= material.text.length;
              continue;
            }

            if (page.reason !== "content_material_missing" && page.reason !== "content_feedback_material_missing") fail(page.reason);
          }

          if (!resolved) {
            const archived = archiveMaterial(state, scope, target.ref);
            if (archived === undefined) return fail("central_runtime_source_missing");
            const material = fragment(archived, target.start, Math.min(32768, remaining));
            selected.push(material);
            remaining -= material.text.length;
          }
        }
      } catch (error) {
        // As with an exactly exhausted budget, keep only the bodies actually delivered.
        // A first-page capacity failure and all non-capacity failures still propagate.
        if (!(error instanceof FragmentCapacityError) || selected.length === 0) throw error;
      }

      return distinct(selected);
    },
  };
}

function opportunity(issue: LearningIssue): CentralLearningOpportunity[] {
  if (issue.decision.kind !== "unreviewed" && issue.decision.kind !== "focused_learning") return [];
  const subject = issueSubject(issue);
  if (subject === undefined) return [];
  return [{ subject,
    sourceRef: issueRef(issue), description: issue.problemKey,
    constraints: [canonicalJson(issue.decision), "Original reports are source claims, not verified outcomes or permissions."] }];
}

function issueSubject(issue: LearningIssue): CentralLearningSubject | undefined {
  const owner = learningIssueOwner(issue);
  return owner === "ambiguous" ? undefined : { plane: "agent", domain: owner === "method" ? "prompt" : owner, issueId: issue.issueId };
}

const issueView = (issue: LearningIssue) => ({ schemaVersion: issue.schemaVersion, issueId: issue.issueId,
  scope: issue.scope, problemKey: issue.problemKey, reports: issue.reports });

function issueConstraint(issue: LearningIssue): CentralRuntimeMaterial {
  const text = canonicalJson({ role: "PA_current_constraint_not_business_evidence", issueId: issue.issueId, decision: issue.decision,
    ...(issue.decision.kind === "focused_learning" ? { readRef: issueRef(issue) } : {}) });
  return { ref: `central-runtime-constraint:${contentHashOf(text)}`, kind: "source", text, sourceRefs: [] };
}

// PA focus/funding are governance, never fresh business evidence.
const issueRef = (issue: LearningIssue) => centralIssueSourceRefs(contentHashOf(issueView(issue))).body;
const issueNoticeRef = (issue: LearningIssue) => centralIssueSourceRefs(contentHashOf(issueView(issue))).notice;
const localIssues = (board: BoardState, scopes: ReadonlySet<string>) => (board.learningIssues ?? []).filter(issue => scopes.has(issue.scope));
const feedbackRef = (issueId: string, hash: string) => `central-runtime-domain:${encodeURIComponent(issueId)}:${hash}`;
const feedbackBodyRef = (issueId: string, hash: string) => `central-runtime-domain-body:${encodeURIComponent(issueId)}:${hash}`;

function safe(value: unknown, options: CentralRuntimeSourceOptions): void {
  if (!isContentDataSafe(value, { scope: options.scope }, options.secrets ?? [])) fail("central_runtime_source_sensitive");
}

function issueCatalog(all: readonly LearningIssue[], selected: readonly LearningIssue[], next = selected.length,
  handoffs: ReadonlySet<string> = new Set()): CentralRuntimeMaterial {
  const text = canonicalJson({ role: "original_report_catalog_not_read_body", availableIssues: all.length,
    shownIssues: selected.length, nextReadRef: next < all.length ? `central-runtime-issue-catalog:${next}` : null,
    entries: selected.map(issue => ({ issueId: issue.issueId, owner: learningIssueOwner(issue), problem: issue.problemKey,
      reportCount: issue.reports.length, role: handoffs.has(issue.issueId) ? "known_learning_handoff_not_new_business" : "original_report",
      noticeRef: handoffs.has(issue.issueId) ? null : issueNoticeRef(issue), readRef: issueRef(issue) })) });
  return { ref: `central-runtime-catalog:${contentHashOf(text)}`, kind: "source", text, sourceRefs: selected.filter(issue => !handoffs.has(issue.issueId)).map(issueNoticeRef) };
}

function exactBoardMaterial(board: BoardState, issues: readonly LearningIssue[], ref: string,
  options: CentralRuntimeSourceOptions): CentralRuntimeMaterial | undefined {
  const catalog = /^central-runtime-issue-catalog:(\d+)$/.exec(ref);
  if (catalog !== null) {
    const start = Number(catalog[1]), native = centralNativeSourceRelations(board, options.scope, issues, undefined, options.compatibleScopes, options.secrets);
    return issueCatalog(issues, issues.slice(start, start + 32), start + 32, native.handoffs);
  }

  const issue = issues.find(item => issueRef(item) === ref || item.issueId === ref || item.reports.some(report => report.reportId === ref));
  if (issue !== undefined) {
    safe(issue, { ...options, scope: issue.scope });
    return { ref: issueRef(issue), kind: "source", text: canonicalJson(issueView(issue)),
      sourceRefs: [issue.issueId, ...issue.reports.flatMap(report => [report.reportId, ...report.evidenceRefs])] };
  }

  const purpose = readCentralPurposeMemory({ facts: board.rewardV2Facts ?? [], scope: options.scope, boardSequence: board.sequence }, ref);
  if (purpose !== undefined) {
    if (!isContentValueCredentialSafe(purpose, options.secrets ?? [])) return fail("central_runtime_source_sensitive");
    return purpose;
  }

  const methodResearch = readCentralMethodResearchMaterial(board, options.scope, ref);
  if (methodResearch !== undefined) {
    safe(methodResearch, options);
    return methodResearch;
  }

  const fact = board.rewardV2Facts?.find(item => item.id === ref && item.scope === options.scope && item.algorithmVersion === CONTENT_ALGORITHM);
  if (fact !== undefined) {
    const record = readContentRecords([fact], options.scope, board.sequence)[0];
    if (record === undefined || !canReadNativeContentRecord(board, options.scope, record,
      { inspectionIssueIds: record.packet.focus === undefined ? [] : [record.packet.focus.issueId] })) return fail("central_runtime_source_forbidden");
    safe(record, options);
    return { ref, kind: "knowledge", text: canonicalJson(record), sourceRefs: [ref, ...record.packet.records.map(item => item.ref)] };
  }

  const asset = board.assets.find(item => item.versionId === ref && item.scope === options.scope && item.kind !== "user_rule");
  if (asset === undefined) return undefined;

  if (!canReadNativeAsset(board, options.scope, asset.versionId)
    || board.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)) return fail("central_runtime_source_forbidden");

  const value = { content: asset.content, source: asset.source, contentHash: asset.contentHash };

  safe(value, options);

  return { ref, kind: "knowledge", text: canonicalJson(value), sourceRefs:
    [asset.versionId, ...(asset.createdFromProposalId === undefined ? [] : [asset.createdFromProposalId])] };
}

function archiveMaterial(board: BoardState, scope: string, ref: string): CentralRuntimeMaterial | undefined {
  let explicit: CentralRuntimeLookup | undefined;

  if (ref.startsWith("central-runtime-archive:")) {
    let value: unknown;

    try { value = JSON.parse(decodeURIComponent(ref.slice("central-runtime-archive:".length))); }
    catch { return fail("central_runtime_archive_reference_invalid"); }

    if (typeof value !== "object" || value === null || !("kind" in value)
      || "factRef" in value && typeof value.factRef !== "string") return fail("central_runtime_archive_reference_invalid");

    const fact = "factRef" in value && typeof value.factRef === "string" ? { factRef: value.factRef } : {};

    if (value.kind === "completed" && "operationId" in value && typeof value.operationId === "string") explicit = { kind: "completed", operationId: value.operationId, ...fact };
    else if (value.kind === "material" && "ref" in value && typeof value.ref === "string") explicit = { kind: "material", ref: value.ref, ...fact };
    else if (value.kind === "ended_intent" && "intentId" in value && typeof value.intentId === "string") explicit = { kind: "ended_intent", intentId: value.intentId, ...fact };
    else return fail("central_runtime_archive_reference_invalid");
  }

  const queries: readonly CentralRuntimeLookup[] = explicit === undefined
    ? [{ kind: "material", ref }, { kind: "completed", operationId: ref }, { kind: "ended_intent", intentId: ref }] : [explicit];

  for (const query of queries) {
    const found = lookupCentralRuntimeRecord(board.rewardV2Facts ?? [], scope, board.sequence, query);
    if (found.status !== "found") continue;
    if ("ref" in found.value && "text" in found.value) return found.value;
    return { ref: `central-runtime-archived:${contentHashOf([found.factRef, found.value])}`, kind: "work_result",
      text: canonicalJson({ role: "exact_original_runtime_archive_not_new_evidence", factRef: found.factRef, value: found.value }),
      sourceRefs: [found.factRef, ref] };
  }

  return undefined;
}

function distinct(materials: readonly CentralRuntimeMaterial[]): CentralRuntimeMaterial[] {
  const result = new Map<string, CentralRuntimeMaterial>();

  for (const item of materials) {
    const previous = result.get(item.ref);
    if (previous !== undefined && (previous.kind !== item.kind || previous.text !== item.text)) fail("central_runtime_source_conflict");
    result.set(item.ref, previous === undefined ? item : { ...item, sourceRefs: [...new Set([...previous.sourceRefs, ...item.sourceRefs])] });
  }

  return [...result.values()];
}

function bounded(materials: readonly CentralRuntimeMaterial[], maximum: number): CentralRuntimeMaterial[] {
  const selected: CentralRuntimeMaterial[] = [];
  let remaining = maximum;

  for (const material of materials) {
    if (material.text.length <= Math.min(32768, remaining)) {
      selected.push(material);
      remaining -= material.text.length;
    }
    else {
      const text = canonicalJson({ sourceRef: material.ref, totalChars: material.text.length,
        readRef: pageRef(material.ref, 0), coverage: "not_read" });
      if (text.length <= remaining) {
        selected.push({ ref: `central-runtime-manifest:${contentHashOf(text)}`, kind: material.kind, text, sourceRefs: material.sourceRefs });
        remaining -= text.length;
      }
    }
  }

  return selected;
}

function fragment(material: CentralRuntimeMaterial, start: number, maximum: number,
  original?: { readonly start: number; readonly totalChars: number }): CentralRuntimeMaterial {
  const high = (point: number) => point >= 0xd800 && point <= 0xdbff, low = (point: number) => point >= 0xdc00 && point <= 0xdfff;
  const endBoundary = (value: string, end: number) => end > 0 && end < value.length && low(value.charCodeAt(end)) && high(value.charCodeAt(end - 1)) ? end - 1 : end;

  if (start > material.text.length || start > 0 && low(material.text.charCodeAt(start)) && high(material.text.charCodeAt(start - 1))) return fail("central_runtime_source_page_invalid");

  if (original === undefined && start === 0 && material.text.length <= maximum) return material;

  let text = material.text.slice(start, endBoundary(material.text, Math.min(material.text.length, start + maximum)));
  const offset = original?.start ?? start, totalChars = original?.totalChars ?? material.text.length;
  const render = () => canonicalJson({ originalRef: material.ref, start: offset, end: offset + text.length, totalChars, text,
    nextRef: offset + text.length < totalChars ? pageRef(material.ref, offset + text.length) : null });
  let body = render();

  while (body.length > maximum && text.length > 0) {
    text = text.slice(0, endBoundary(text, Math.max(0, text.length - Math.max(1, body.length - maximum))));
    body = render();
  }

  if (text.length === 0 || body.length > maximum) throw new FragmentCapacityError();

  // The body stays verbatim. Navigation/coverage is explicit in this public wrapper.
  return { ref: `central-runtime-fragment:${contentHashOf([material.ref, offset, text])}`, kind: material.kind,
    text: body, sourceRefs: [...new Set([material.ref, ...material.sourceRefs])] };
}
