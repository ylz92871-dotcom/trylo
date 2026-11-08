import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { prepareKnownApplication, prepareResidualReview, compileContentProcess } from "../../learning/central/content/process.js";
import type { ContentSemanticRequest, ResidualReviewDraft } from "../../learning/central/content/process-contract.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { isContentDataSafe } from "./content-confidentiality.js";
import type { NormalTaskContentRuntime } from "./task-runtime-contract.js";
import { contentStageDraft, contentStageRecords, type ContentStageBody, type ContentStageRecord } from "./staged-records.js";
import { extendContentStagePacket, replaceContentStagePacket } from "./staged-material.js";

export type StagedContentResult = { readonly status: "apply_known" | "residual_review"; readonly stageRef: string;
  readonly request: ContentSemanticRequest; readonly issueId?: string }
  | { readonly status: "published" | "publication_pending"; readonly stageRef: string; readonly packetId: string; readonly processId: string;
      readonly issueId?: string; readonly domain: ContentPacket["domain"];
      readonly recommendation: ResidualReviewDraft["recommendation"];
      readonly remaining: readonly { readonly id: string; readonly question: string; readonly whenRelevant: string; readonly expectedChange: string }[];
      readonly assessmentBasis: "domain_model_assessment_not_external_result_qualification";
      readonly publication: Awaited<ReturnType<NormalTaskContentRuntime["publish"]>> }
  | { readonly status: "rejected" | "stale" | "unconfirmed"; readonly reason: string };

const fail = (reason: string): StagedContentResult => ({ status: "rejected", reason });

/** PA/tool turns carry the semantic steps. There are no hidden model calls, worker claims or funding actions. */
export function createStagedContentSession(options: { readonly runtime: NormalTaskContentRuntime; readonly enabled: () => boolean;
  readonly secrets?: readonly string[] }) {
  const { identity } = options.runtime;
  const board = createRewardV2BoardPort(identity.boardRoot, options.enabled);
  let suspended = false;
  const check = (signal: AbortSignal) => !options.enabled() ? "collect_disabled" : signal.aborted ? "content_cancelled"
    : suspended ? "content_stage_writer_suspended" : undefined;

  async function read() {
    const snapshot = await board.read();
    return { ...snapshot, stages: contentStageRecords(snapshot.facts, identity.scope, snapshot.revision)
      .filter(row => row.body.sessionId === identity.sessionId && row.body.turnId === identity.turnId) };
  }

  // An unconfirmed append suspends this writer; the caller must reconcile the durable stages.
  async function save(revision: number, value: ContentStageBody, signal: AbortSignal): Promise<{ readonly ok: true; readonly ref: string; readonly revision: number }
    | { readonly ok: false; readonly result: StagedContentResult }> {
    const stopped = check(signal);
    if (stopped) return { ok: false, result: fail(stopped) };

    if (!isContentDataSafe(value, identity, options.secrets ?? [])) return { ok: false, result: fail("topic_sensitive_content") };

    const fact = contentStageDraft(identity.scope, value);

    try {
      const written = await board.append(revision, fact);
      return written.status === "stale" ? { ok: false, result: { status: "stale", reason: "content_stage_stale" } }
        : { ok: true, ref: fact.id, revision: written.revision };
    } catch {
      suspended = true;
      return { ok: false, result: { status: "unconfirmed", reason: "content_stage_write_unconfirmed" } };
    }
  }

  // Follow the persisted preparation lineage rather than treating a later stage as a new source.
  function preparation(stages: readonly ContentStageRecord[], ref: string) {
    const row = stages.find(item => item.ref === ref);
    const applied = row?.body.kind === "applied" ? row : row?.body.kind === "reviewed"
      ? stages.find(item => row.body.kind === "reviewed" && item.ref === row.body.applicationRef && item.body.kind === "applied") : undefined;
    let current = row?.body.kind === "prepared" ? row : applied?.body.kind === "applied" ? stages.find(item => applied.body.kind === "applied"
      && item.ref === applied.body.preparationRef && item.body.kind === "prepared") : undefined;

    for (let count = 0; current !== undefined && count < 64; count += 1) {
      const ref = current.ref;
      const children = stages.filter(item => item.body.kind === "prepared" && item.body.extendsStageRef === ref);
      if (children.length === 0) return current;
      if (children.length > 1) throw new Error("content_stage_expansion_conflict");
      current = children[0];
    }

    if (current !== undefined) throw new Error("content_stage_expansion_capacity");

    return undefined;
  }

  function requestFor(packet: ContentPacket, maximum: number, applicationJson?: string) {
    return applicationJson === undefined ? prepareKnownApplication(packet, maximum) : prepareResidualReview(packet, applicationJson, maximum);
  }

  const api = {
    async begin(input: { readonly issueId?: string; readonly requestId?: string; readonly maximumPromptChars: number }, signal: AbortSignal): Promise<StagedContentResult> {
      const stopped = check(signal);
      if (stopped) return fail(stopped);

      if (!Number.isSafeInteger(input.maximumPromptChars) || input.maximumPromptChars < 1 || input.maximumPromptChars > 100000) return fail("content_stage_capacity");

      const requestId = input.requestId ?? `turn-content:${contentHashOf([identity.turnId, input.issueId ?? "task"])}`;
      if (!requestId.trim() || requestId.length > 256) return fail("content_stage_request_identity");

      const before = await read();
      const originalBegin = before.stages.find(row => row.body.kind === "prepared" && row.body.requestId === requestId
        && row.body.sessionId === identity.sessionId && row.body.turnId === identity.turnId);
      const existing = originalBegin === undefined ? undefined : preparation(before.stages, originalBegin.ref);
      let refreshFrom: string | undefined;
      let refreshed: Awaited<ReturnType<NormalTaskContentRuntime["prepare"]>> | undefined;

      if (existing?.body.kind === "prepared") {
        const applied = before.stages.find(row => row.body.kind === "applied" && row.body.preparationRef === existing.ref);
        if (applied?.body.kind === "applied") {
          const reviewed = before.stages.find(row => row.body.kind === "reviewed" && row.body.applicationRef === applied.ref);
          if (reviewed?.body.kind === "reviewed") {
            // Explicit request IDs are immutable operation retries. The default PA resume must,
            // however, make progress when the same turn receives new source feedback.
            const admission = input.requestId !== undefined || input.issueId === undefined || options.runtime.currentAdmission === undefined
              ? undefined : await options.runtime.currentAdmission(input.issueId, signal);
            if (admission?.status === "needs_content") {
              if (admission.processId !== undefined) refreshFrom = existing.ref;
              else {
                // No completed result can also mean the prior publication was interrupted.
                // Refresh changed focus/report content; otherwise retry that same publication.
                refreshed = await options.runtime.prepare(input, signal);

                if (!refreshed.ok) return fail(refreshed.reason);

                const source = (packet: ContentPacket) => packet.focus === undefined ? null
                  : { issueId: packet.focus.issueId, scope: packet.focus.scope, decision: packet.focus.decision, reports: packet.focus.reports };
                if (canonicalJson(source(refreshed.value.packet)) !== canonicalJson(source(existing.body.packet))) refreshFrom = existing.ref;
              }
              if (refreshFrom === undefined) return api.review({ stageRef: applied.ref, inputHash: applied.body.requestHash, reviewJson: reviewed.body.reviewJson }, signal);
            }
            else if (admission?.status === "review_required") return fail(admission.reason);
            else return api.review({ stageRef: applied.ref, inputHash: applied.body.requestHash, reviewJson: reviewed.body.reviewJson }, signal);
          }

          if (refreshFrom === undefined) {
            const request = requestFor(existing.body.packet, existing.body.maximumPromptChars, applied.body.applicationJson);
            return request.ok ? { status: "residual_review", stageRef: applied.ref, request: request.value } : fail(request.reason);
          }
        }

        if (refreshFrom === undefined) {
          const request = requestFor(existing.body.packet, existing.body.maximumPromptChars);
          return request.ok && request.value.inputHash === existing.body.requestHash
            ? { status: "apply_known", stageRef: existing.ref, request: request.value } : fail("content_stage_input_changed");
        }
      }

      const prepared = refreshed ?? await options.runtime.prepare(input, signal);
      if (!prepared.ok) return fail(prepared.reason);

      const packet = prepared.value.packet, request = requestFor(packet, input.maximumPromptChars);
      if (!request.ok) return fail(request.reason);

      const snapshot = await read();
      if (refreshFrom !== undefined && preparation(snapshot.stages, refreshFrom)?.ref !== refreshFrom) return fail("content_stage_changed_during_preparation");

      if (originalBegin === undefined && snapshot.stages.some(row => row.body.kind === "prepared" && row.body.requestId === requestId)) {
        return { status: "stale", reason: "content_stage_prepared_concurrently" };
      }

      const saved = await save(snapshot.revision, { schemaVersion: 1, sessionId: identity.sessionId, turnId: identity.turnId,
        kind: "prepared", requestId, packet, maximumPromptChars: input.maximumPromptChars, requestHash: request.value.inputHash,
        ...(refreshFrom === undefined ? {} : { extendsStageRef: refreshFrom }) }, signal);

      return saved.ok ? { status: "apply_known", stageRef: saved.ref, request: request.value,
        ...(packet.focus === undefined ? {} : { issueId: packet.focus.issueId }) } : saved.result;
    },

    async applyKnown(input: { readonly stageRef: string; readonly inputHash: string; readonly applicationJson: string }, signal: AbortSignal): Promise<StagedContentResult> {
      const stopped = check(signal);
      if (stopped) return fail(stopped);

      const snapshot = await read(), original = preparation(snapshot.stages, input.stageRef);
      if (original?.body.kind !== "prepared") return fail("content_preparation_missing");

      const first = requestFor(original.body.packet, original.body.maximumPromptChars);
      if (!first.ok || first.value.inputHash !== original.body.requestHash || input.inputHash !== original.body.requestHash) return fail("content_stage_input_changed");

      const request = requestFor(original.body.packet, original.body.maximumPromptChars, input.applicationJson);
      if (!request.ok) return fail(request.reason);

      const applicationJson = canonicalJson(JSON.parse(input.applicationJson));
      const previous = snapshot.stages.filter(row => row.body.kind === "applied" && row.body.preparationRef === original.ref);
      if (previous.some(row => row.body.kind === "applied" && row.body.applicationJson !== applicationJson)) return fail("content_stage_conflict");

      const saved = await save(snapshot.revision, { schemaVersion: 1, sessionId: identity.sessionId, turnId: identity.turnId,
        kind: "applied", preparationRef: original.ref, applicationJson, requestHash: request.value.inputHash }, signal);

      return saved.ok ? { status: "residual_review", stageRef: saved.ref, request: request.value,
        ...(original.body.packet.focus === undefined ? {} : { issueId: original.body.packet.focus.issueId }) } : saved.result;
    },

    async review(input: { readonly stageRef: string; readonly inputHash: string; readonly reviewJson: string }, signal: AbortSignal): Promise<StagedContentResult> {
      const stopped = check(signal);
      if (stopped) return fail(stopped);

      const snapshot = await read(), applied = snapshot.stages.find(row => row.ref === input.stageRef);
      if (applied?.body.kind !== "applied") return fail("content_application_missing");

      const original = preparation(snapshot.stages, applied.body.preparationRef);
      if (original?.body.kind !== "prepared") return fail("content_preparation_missing");

      const request = requestFor(original.body.packet, original.body.maximumPromptChars, applied.body.applicationJson);
      if (!request.ok || request.value.inputHash !== applied.body.requestHash || input.inputHash !== applied.body.requestHash) return fail("content_stage_input_changed");

      const output = compileContentProcess(original.body.packet, applied.body.applicationJson, input.reviewJson);
      if (!output.ok) return fail(output.reason);

      const reviewJson = canonicalJson(JSON.parse(input.reviewJson));
      if (snapshot.stages.some(row => row.body.kind === "reviewed" && row.body.applicationRef === applied.ref && row.body.reviewJson !== reviewJson)) return fail("content_stage_conflict");

      const saved = await save(snapshot.revision, { schemaVersion: 1, sessionId: identity.sessionId, turnId: identity.turnId,
        kind: "reviewed", applicationRef: applied.ref, reviewJson }, signal);
      if (!saved.ok) return saved.result;

      const cancelled = check(signal);
      if (cancelled) return fail(cancelled);

      const publication = await options.runtime.publish(original.body.packet, output.value, saved.revision);

      return { status: publication.status === "published" || publication.status === "content_saved" ? "published" : "publication_pending",
        stageRef: saved.ref, packetId: original.body.packet.packetId, processId: output.value.processId, publication,
        domain: original.body.packet.domain, ...(original.body.packet.focus === undefined ? {} : { issueId: original.body.packet.focus.issueId }),
        recommendation: output.value.review.recommendation,
        remaining: output.value.remaining.map(({ id, question, whenRelevant, expectedChange }) => ({ id, question, whenRelevant, expectedChange })),
        assessmentBasis: "domain_model_assessment_not_external_result_qualification" };
    },

    /** Fetching a previously deferred source admits a new immutable preparation and returns its
     * real request/hash. Old stage inputs cannot cite a page that was never in their material. */
    async readMaterial(input: { readonly stageRef: string; readonly evidenceRef: string; readonly start?: number; readonly maximumChars?: number }, signal: AbortSignal) {
      const stopped = check(signal);
      if (stopped) return { ok: false as const, reason: stopped };

      const snapshot = await read(), original = preparation(snapshot.stages, input.stageRef);
      if (original?.body.kind !== "prepared") return { ok: false as const, reason: "content_preparation_missing" };

      const record = original.body.packet.records.find(row => row.ref === input.evidenceRef);
      const start = input.start ?? 0, maximum = input.maximumChars ?? 2048;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximum) || maximum < 2 || maximum > 8192) return { ok: false as const, reason: "content_page_invalid" };

      if (record === undefined) {
        const page = await options.runtime.readMaterial({ packet: original.body.packet, evidenceRef: input.evidenceRef, start, maximumChars: maximum }, signal);
        if (!page.ok) {
          if (page.reason !== "content_material_missing" && page.reason !== "content_feedback_material_missing") return page;

          if (!original.body.packet.retrieval.requestedRefs.includes(input.evidenceRef)) return page;

          const current = await options.runtime.prepare(original.body.packet.focus === undefined ? {} : { issueId: original.body.packet.focus.issueId }, signal);
          if (!current.ok) return current;

          const replacement = current.value.packet;

          // A cold source cache can no longer reproduce an old derived feedback frame after
          // genuine late feedback. Move to the current input explicitly; never return new text
          // under the old ref. Still-advertised missing sources remain a real transport failure.
          if (replacement.records.some(row => row.ref === input.evidenceRef)
            || replacement.materials.some(row => row.recordRefs.includes(input.evidenceRef))
            || replacement.aliases?.some(row => row.ref === input.evidenceRef)) return page;

          const latest = await read();
          if (preparation(latest.stages, original.ref)?.ref !== original.ref) return { ok: false as const, reason: "content_stage_changed_during_material_read" };

          const previous = latest.stages.find(row => row.body.kind === "applied" && row.body.preparationRef === original.ref);
          const nextPacket = replaceContentStagePacket(replacement, latest.revision, previous);
          if (!nextPacket.ok) return nextPacket;

          const request = requestFor(nextPacket.value, original.body.maximumPromptChars);
          if (!request.ok) return request;

          const saved = await save(latest.revision, { schemaVersion: 1, sessionId: identity.sessionId, turnId: identity.turnId,
            kind: "prepared", requestId: `source-refresh:${contentHashOf([original.ref, nextPacket.value.packetId])}`, extendsStageRef: original.ref,
            packet: nextPacket.value, maximumPromptChars: original.body.maximumPromptChars, requestHash: request.value.inputHash }, signal);

          return saved.ok ? { ok: false as const, reason: "content_material_snapshot_changed",
            unavailableRef: input.evidenceRef, next: { status: "apply_known" as const, stageRef: saved.ref, request: request.value },
            instruction: "The unread old frame is no longer available from its owner snapshot. Continue from next using the current source data; no replacement text was returned under the old ref." }
            : { ok: false as const, reason: "content_source_refresh_not_saved", publication: saved.result };
        }

        const latest = await read(), active = preparation(latest.stages, original.ref);
        if (active?.ref !== original.ref) return { ok: false as const, reason: "content_stage_changed_during_material_read" };

        const previous = latest.stages.find(row => row.body.kind === "applied" && row.body.preparationRef === original.ref);
        const extended = extendContentStagePacket(original.body.packet, page.value, latest.revision, previous);
        if (!extended.ok) return extended;

        const request = requestFor(extended.value, original.body.maximumPromptChars);
        if (!request.ok) return request;

        const evidence = extended.value.records.find(row => row.ref === `content-source-page:${contentHashOf(page.value)}`)!;

        if (extended.value.packetId === original.body.packet.packetId) return { ok: true as const, record: evidence,
          source: page.value, sourceHash: sha256Hex(evidence.text), stageRef: original.ref };

        const saved = await save(latest.revision, { schemaVersion: 1, sessionId: identity.sessionId, turnId: identity.turnId,
          kind: "prepared", requestId: `source-page:${contentHashOf([original.ref, evidence.ref])}`, extendsStageRef: original.ref,
          packet: extended.value, maximumPromptChars: original.body.maximumPromptChars, requestHash: request.value.inputHash }, signal);
        if (!saved.ok) return { ok: false as const, reason: "content_source_page_not_saved", publication: saved.result };

        return { ok: true as const, record: evidence, source: page.value, sourceHash: sha256Hex(evidence.text),
          next: { status: "apply_known" as const, stageRef: saved.ref, request: request.value },
          instruction: "This source page is now admitted to the successor input. Use next.stageRef and next.request.inputHash; prior public applications are retained for reuse." };
      }

      if (start > record.text.length || start > 0 && /[\udc00-\udfff]/.test(record.text[start]!)) return { ok: false as const, reason: "content_page_invalid" };

      if (start === record.text.length) return { ok: false as const, reason: "content_material_no_progress" };

      let end = Math.min(record.text.length, start + maximum);
      if (end < record.text.length && /[\ud800-\udbff]/.test(record.text[end - 1]!)) end -= 1;

      return { ok: true as const, record: { ...record, text: record.text.slice(start, end) }, start, end,
        totalChars: record.text.length, sourceHash: sha256Hex(record.text) };
    },
  };

  return Object.freeze(api);
}
