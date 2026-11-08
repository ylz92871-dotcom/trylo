import type { BoardState } from "../../learning/control/state.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { DomainFeedbackMaterialTransport, ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { projectContentSourceText } from "../learning-content/sources/source-text-view.js";
import { createCentralPublicSourceFrames, readCentralPublicSourceFrame, type CentralPublicSourceFrame, type CentralPublicSourceFramesOptions } from "./public-source-frames.js";
import { createNativeFeedbackUnitPublicView, isNativeFeedbackUnitPublicView } from "./native-feedback-unit-view.js";
import type { OrganizationNativeFeedbackUnit } from "./organization-feedback-sources.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import { centralSourceReadScopes } from "./runtime-source-changes.js";

export const PUBLIC_SOURCE_BODY_PREFIX = "central-runtime-public-body:";
export const runtimePublicSourceBodyRef = (scope: string, issueId: string, publicTextHash: string) =>
  `${PUBLIC_SOURCE_BODY_PREFIX}${contentHashOf([scope, issueId, publicTextHash])}`;
const domainOf = (issue: LearningIssue) => {
  const owner = learningIssueOwner(issue);
  return owner === "method" ? "prompt" : owner;
};
const failure = (reason: string): never => { throw new Error(reason); };
const reference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const coordinate = (value: unknown) => fields(value, ["runId", "sequence"]) && reference(value.runId) && sequence(value.sequence);

/** One authoritative pure lookup for source and research readers. Observed
 * cache bytes authenticate no model delivery or independent quality claim. */
export function readRuntimePublicSourceFrame(board: BoardState,
  input: { readonly scope: string; readonly ref: string; readonly secrets?: readonly string[];
    readonly compatibleScopes?: readonly string[] }): CentralPublicSourceFrame | undefined {
  if (!input.ref.startsWith(PUBLIC_SOURCE_BODY_PREFIX)) return undefined;

  const saved = readCentralPublicSourceFrame(board.rewardV2Facts ?? [], { ...input, boardSequence: board.sequence });
  if (saved === undefined) return undefined;

  const origin = saved.origin;
  if (!fields(origin, ["schemaVersion", "issueId", "domain", "kind", "originalSourceRef", "originalSourceHash",
    "originalCoordinate", "publicViewRef", "publicCoordinate", "publicTextHash",
    ...(Object.hasOwn(origin, "originalIssueScope") ? ["originalIssueScope"] : [])]) || origin.schemaVersion !== 1
    || !["native_unit", "owner_frame", "native_dependency"].includes(String(origin.kind))
    || !reference(origin.issueId) || !reference(origin.originalSourceRef) || !reference(origin.publicViewRef)
    || !hash(origin.originalSourceHash) || !coordinate(origin.originalCoordinate) || !coordinate(origin.publicCoordinate)
    || origin.publicTextHash !== saved.publicTextHash || input.ref !== runtimePublicSourceBodyRef(input.scope, origin.issueId, saved.publicTextHash)) {
    return failure("central_runtime_source_frame_identity");
  }

  const originalIssueScope = Object.hasOwn(origin, "originalIssueScope") ? origin.originalIssueScope : input.scope;

  // A primary archive is already observed history. Current source aliases gate
  // new reads, not the identity of previously archived original owner bytes.
  if (typeof originalIssueScope !== "string") return failure("central_runtime_source_forbidden");

  const issue = board.learningIssues?.find(row => row.scope === originalIssueScope && row.issueId === origin.issueId);
  if (issue === undefined || domainOf(issue) === "ambiguous" || origin.domain !== domainOf(issue)) return failure("central_runtime_source_forbidden");

  if (origin.kind === "native_unit") {
    let unit: unknown;
    try { unit = JSON.parse(saved.text); } catch { return failure("central_runtime_source_public_unit_invalid"); }
    if (!isNativeFeedbackUnitPublicView(unit) || unit.issueId !== issue.issueId || unit.domain !== origin.domain) {
      return failure("central_runtime_source_public_unit_invalid");
    }
  }

  return saved;
}

/** This is the original Board's observed-source cache. Full cached text is never
 * inserted into the runtime's delivered-material or notice-consumption ledgers. */
export function createRuntimeSourceFrames(options: CentralPublicSourceFramesOptions & {
  readonly compatibleScopes?: readonly string[]; readonly readCompatibleScopes?: () => readonly string[];
}) {
  const archive = createCentralPublicSourceFrames(options);
  const scopesFor = (issue: LearningIssue, compatibleScopes?: readonly string[]) => {
    const aliases = compatibleScopes !== undefined ? compatibleScopes
      : options.readCompatibleScopes === undefined ? options.compatibleScopes : options.readCompatibleScopes();
    const scopes = new Set(centralSourceReadScopes(options.scope, aliases));
    if (!scopes.has(issue.scope) || domainOf(issue) === "ambiguous") failure("central_runtime_source_forbidden");
    return scopes;
  };
  const material = (frame: CentralPublicSourceFrame): CentralRuntimeMaterial =>
    ({ ref: frame.ref, kind: "feedback", text: frame.text, sourceRefs: frame.sourceRefs });
  const freeze = async (issue: LearningIssue, text: string, sourceRefs: readonly string[], origin: JsonObject,
    readableScopes: ReadonlySet<string>, signal: AbortSignal) => {
    if (!readableScopes.has(issue.scope) || domainOf(issue) === "ambiguous") failure("central_runtime_source_forbidden");
    const publicTextHash = contentHashOf(text), ref = runtimePublicSourceBodyRef(options.scope, issue.issueId, publicTextHash);
    const saved = await archive.freeze({ ref, text, sourceRefs: [...new Set(sourceRefs)],
      origin: { schemaVersion: 1, issueId: issue.issueId, domain: domainOf(issue), ...origin,
        ...(issue.scope === options.scope ? {} : { originalIssueScope: issue.scope }), publicTextHash } }, signal);
    return material(saved);
  };

  return {
    async read(ref: string, board: BoardState, signal: AbortSignal) {
      if (!options.enabled()) failure("collect_disabled");
      if (signal.aborted) failure("central_runtime_source_cancelled");
      const saved = readRuntimePublicSourceFrame(board, { scope: options.scope, ref,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
      if (saved === undefined) return undefined;
      return material(saved);
    },

    async unit(issue: LearningIssue, change: ContentDomainFeedbackChange,
      unit: Extract<OrganizationNativeFeedbackUnit, { readonly kind: "found" }>, signal: AbortSignal, compatibleScopes?: readonly string[]) {
      const readableScopes = scopesFor(issue, compatibleScopes);
      const sourceRef = `native-feedback-unit:${contentHashOf([change.domain, change.issueId, change.factRef, change.unitRef, change.revisionRef, change.kind])}`;
      const text = canonicalJson(createNativeFeedbackUnitPublicView(change, unit.recordKind, unit.payload));
      const view = projectContentSourceText({ ref: sourceRef, runId: sourceRef, sequence: 0, scope: issue.scope,
        origin: "model_proposal", text }, options.secrets);
      let publicValue: unknown;
      try { publicValue = JSON.parse(view.record.text); } catch { failure("central_runtime_source_public_unit_invalid"); }

      if (!isNativeFeedbackUnitPublicView(publicValue)) failure("central_runtime_source_public_unit_invalid");

      return freeze(issue, view.record.text, unit.sourceRefs, { kind: "native_unit",
        originalSourceRef: sourceRef, originalSourceHash: view.original.sourceHash,
        originalCoordinate: { runId: view.original.runId, sequence: view.original.sequence },
        publicViewRef: view.record.ref, publicCoordinate: { runId: view.record.runId, sequence: view.record.sequence } }, readableScopes, signal);
    },

    async owner(issue: LearningIssue, owner: DomainFeedbackMaterialTransport, frame: DomainFeedbackMaterialTransport["coverage"]["frames"][number],
      signal: AbortSignal, compatibleScopes?: readonly string[]) {
      const readableScopes = scopesFor(issue, compatibleScopes);
      let start = 0, text = "", publicHash: string | undefined, first: ReturnType<typeof owner.readMaterial> | undefined;

      for (;;) {
        const page = owner.readMaterial(frame.ref, start, 8192);
        if (!page.ok) return failure(page.reason);

        first ??= page;
        publicHash ??= page.value.contentHash;

        if (page.value.start !== start || page.value.contentHash !== publicHash || page.value.end < start
          || page.value.end - start !== page.value.text.length || page.value.end === start && start < page.value.totalChars) failure("central_runtime_source_frame_changed");

        text += page.value.text;
        start = page.value.end;

        if (text.length > 1048576) failure("central_runtime_source_capacity");

        if (start === page.value.totalChars) break;
      }

      if (first === undefined || !first.ok || contentHashOf(text) !== publicHash) return failure("central_runtime_source_frame_changed");

      const original = first.value.originalSource ?? { ref: frame.ref, runId: first.value.coordinate.runId,
        sequence: first.value.coordinate.sequence, sourceHash: frame.sourceHash };
      if (original.sourceHash !== frame.sourceHash) failure("central_runtime_source_frame_changed");

      return freeze(issue, text, first.value.sourceRefs, { kind: "owner_frame", originalSourceRef: original.ref,
        originalSourceHash: original.sourceHash, originalCoordinate: { runId: original.runId, sequence: original.sequence },
        publicViewRef: first.value.ref, publicCoordinate: { runId: first.value.coordinate.runId, sequence: first.value.coordinate.sequence } }, readableScopes, signal);
    },

    async dependency(issue: LearningIssue, value: CentralRuntimeMaterial, signal: AbortSignal, compatibleScopes?: readonly string[]) {
      const readableScopes = scopesFor(issue, compatibleScopes);
      const view = projectContentSourceText({ ref: value.ref, runId: value.ref, sequence: 0, scope: issue.scope,
        origin: "model_proposal", text: value.text }, options.secrets);
      return freeze(issue, view.record.text, value.sourceRefs, { kind: "native_dependency", originalSourceRef: value.ref,
        originalSourceHash: view.original.sourceHash, originalCoordinate: { runId: view.original.runId, sequence: view.original.sequence },
        publicViewRef: view.record.ref, publicCoordinate: { runId: view.record.runId, sequence: view.record.sequence } }, readableScopes, signal);
    },
  };
}
