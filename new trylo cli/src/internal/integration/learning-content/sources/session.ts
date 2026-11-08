import type { SessionRecordView } from "../../../ports/session.js";
import type { ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { mergeContentBatches } from "../../../learning/central/content/material.js";
import { isContentRetrievalQuery } from "../../../learning/central/content/material-parse.js";
import { decodeSessionContent, sessionContentRecordView, validateSessionContentJournal } from "./session-decode.js";
import { locateSessionContent, readSessionContentAddress, readSessionTaskAddress, sessionContentAddress, sessionContentLocators, type SessionContentLocator } from "./session-address.js";
import type { SessionContentInput, SessionContentPage, SessionContentRead, SessionContentSource } from "./session-contract.js";
import { sessionMaterialCatalog } from "./session-catalog.js";
import { buildRequiredUserIndex, readRequiredUserCatalogAddress, type RequiredUserIndex } from "./session-required-index.js";
import { pageContentMaterial } from "./artifact-read.js";
import { isPureSessionTurnAddress, readSessionPublicTurnAddress, readSessionPublicTurnMaterial } from "./session-public-turn.js";

export { sessionContentRecordRef, sessionContentChunkRunId, sessionContentRecordView, decodeSessionContent } from "./session-decode.js";
export { sessionContentAddress, readSessionContentAddress, sessionTaskAddress, readSessionTaskAddress } from "./session-address.js";
export { sessionSourceAddressesForIssue, sessionSourceAddressCatalogForIssue } from "./session-issue-address.js";
export type { SessionContentAddress } from "./session-address.js";
export type { SessionContentInput, SessionContentRead, SessionContentCoverage, SessionContentSource, SessionContentPage, SessionMaterialCatalog } from "./session-contract.js";

type Snapshot = { readonly view: SessionRecordView; readonly locators: readonly SessionContentLocator[] };

/** Capture real journal prefixes once; focus lookup recovers the original turn instead of its latest summary. */
export async function readSessionContent(input: SessionContentInput, signal: AbortSignal): Promise<SessionContentRead> {
  if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

  if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

  let outcome;

  try { outcome = await input.session.readRecords(); }
  catch { return { ok: false, reason: "content_material_unavailable" }; }

  if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

  if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

  if (!outcome.ok) return { ok: false, reason: outcome.code };

  const decoded = decodeSessionContent(outcome.view, input);
  if (!decoded.ok) return decoded;

  const workspaceId = decoded.coverage.workspaceId;
  const admitted = mergeContentBatches([decoded.batch]);
  if (!admitted.ok) return admitted;

  const view = structuredClone({ ...outcome.view, records: outcome.view.records.slice(0, decoded.coverage.observedThrough + 1) });
  let locators;

  try { locators = sessionContentLocators(view, input.sessionId, input.excludeToolNames, input); }
  catch { return { ok: false, reason: "content_source_envelope_invalid" }; }

  const snapshots = new Map<string, Snapshot>([[input.sessionId, { view, locators }]]);
  const taskSources = new Map<string, { readonly sessionId: string; readonly snapshot: Snapshot } | undefined>();

  // Cache each journal prefix so later page reads keep the same evidence coordinates.
  async function snapshotFor(sessionId: string, currentSignal: AbortSignal): Promise<Snapshot | undefined> {
    const saved = snapshots.get(sessionId);
    if (saved !== undefined) return saved;

    if (input.lookupSession === undefined) return undefined;

    const session = await input.lookupSession(sessionId, currentSignal);
    if (session === undefined) return undefined;

    const read = await session.readRecords();
    if (!read.ok) throw new Error(read.code);

    const checked = validateSessionContentJournal(read.view, sessionId);
    if (!checked.ok || checked.workspaceId !== workspaceId && !input.compatibleWorkspaceIds?.includes(checked.workspaceId)) throw new Error("content_material_scope");

    const sourceView = structuredClone(read.view), result = { view: sourceView, locators: sessionContentLocators(sourceView, sessionId, input.excludeToolNames, input) };

    snapshots.set(sessionId, result);

    return result;
  }

  async function requiredCatalog(ref: string, currentSignal: AbortSignal) {
    const address = readRequiredUserCatalogAddress(ref);
    if (address === undefined) return undefined;

    const saved = await snapshotFor(address.sessionId, currentSignal);
    if (saved === undefined) return undefined;

    const read = decodeSessionContent(saved.view, { ...input, sessionId: address.sessionId, turnId: address.turnId, through: address.through });
    if (!read.ok) return undefined;

    const indexed = buildRequiredUserIndex({ sources: read.requiredSources, sessionId: address.sessionId, turnId: address.turnId,
      through: address.through, scope: input.scope, subsystem: input.subsystem, maximumChars: input.maximumChars ?? 48000 });

    return indexed.ok && indexed.value.catalog.ref === ref ? { index: indexed.value, address } : undefined;
  }

  function requiredCatalogPage(index: RequiredUserIndex, sessionId: string, through: number, requestedRef: string, start: number,
    maximumChars: number, currentSignal: AbortSignal): SessionContentPage | { readonly ok: false; readonly reason: string } {
    const ref = index.catalog.ref;
    const page = pageContentMaterial({ ref, requestedRef, text: index.catalog.text, originalScope: input.scope,
      sourceRefs: [], admissibility: "source_record", origin: "execution_result", coordinate: { runId: ref, sequence: 0 } }, start, maximumChars);
    if (!page.ok) return page;

    if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

    if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

    return { ok: true, value: { ref: page.value.ref, sessionId, journalSequence: through,
      sourceHash: page.value.contentHash, start: page.value.start, end: page.value.end, totalChars: page.value.totalChars,
      text: page.value.text, origin: "execution_result", originalScope: input.scope, sourceRecordType: "required_user_catalog", coordinate: page.value.coordinate } };
  }

  async function sourceForTask(taskId: string, currentSignal: AbortSignal) {
    if (taskSources.has(taskId)) return taskSources.get(taskId);

    const known = [...snapshots].filter(([_id, snapshot]) => snapshot.locators.some(row => row.turnId === taskId)).map(([id]) => id);
    const ids = known.length > 0 ? known : await input.lookupSessionsForTask?.(taskId, currentSignal) ?? [];
    const matches: { readonly sessionId: string; readonly snapshot: Snapshot }[] = [];

    for (const sessionId of new Set(ids)) {
      let snapshot;
      try { snapshot = await snapshotFor(sessionId, currentSignal); }
      catch (error) {
        if (error instanceof Error && error.message === "content_material_scope") continue;
        throw error;
      }
      if (snapshot?.locators.some(row => row.turnId === taskId)) matches.push({ sessionId, snapshot });
    }

    if (matches.length > 1) throw new Error("content_source_task_ambiguous");

    taskSources.set(taskId, matches[0]);
    return matches[0];
  }

  const source: SessionContentSource = {
    async listMaterials(currentSignal, request = {}) {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

      if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

      const sessionId = request.sessionId ?? input.sessionId;

      try {
        const saved = await snapshotFor(sessionId, currentSignal);
        if (saved === undefined) return { ok: false, reason: "content_material_missing" };
        const catalog = sessionMaterialCatalog(saved.view, saved.locators, sessionId, request, input);
        if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
        if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };
        return catalog === undefined ? { ok: false, reason: "content_material_range_invalid" } : { ok: true, value: catalog };
      } catch { return { ok: false, reason: "content_material_unavailable" }; }
    },

    async retrieve(query, currentSignal) {
      if (!input.enabled()) return { ok: false, reason: "content_material_unavailable" };

      if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (!isContentRetrievalQuery(query)) return { ok: false, reason: "content_material_invalid" };

      if (query.scope !== input.scope) return { ok: false, reason: "content_material_scope" };

      try {
        const batches: ContentMaterialBatch[] = [], aliases: { readonly ref: string; readonly recordRefs: readonly string[] }[] = [];
        const association: { readonly ref: string; readonly sessionId: string; readonly locators: readonly SessionContentLocator[] }[] = [];

        for (const ref of query.sourceRefs) {
          if (decoded.requiredIndex?.batch.records.some(record => record.ref === ref)) {
            batches.push(decoded.requiredIndex.batch);
            continue;
          }

          if (readRequiredUserCatalogAddress(ref) !== undefined) {
            const catalog = await requiredCatalog(ref, currentSignal);
            if (catalog !== undefined) batches.push(catalog.index.batch);
            continue;
          }

          const taskId = readSessionTaskAddress(ref), task = taskId === undefined ? undefined : await sourceForTask(taskId, currentSignal);
          if (taskId !== undefined && task === undefined) continue;

          let sessionId = task?.sessionId ?? readSessionContentAddress(ref)?.sessionId ?? input.sessionId;
          let saved = task?.snapshot ?? await snapshotFor(sessionId, currentSignal);
          if (saved === undefined) continue;

          let matched = locateSessionContent(taskId === undefined ? ref : sessionContentAddress({ sessionId, turnId: taskId }), sessionId, saved.locators);

          // A bare canonical session ID is also a valid registry key. Other opaque refs remain missing.
          if (matched.length === 0 && readSessionContentAddress(ref) === undefined && input.lookupSession !== undefined) {
            const candidate = await snapshotFor(ref, currentSignal);
            if (candidate !== undefined) {
              sessionId = ref;
              saved = candidate;
              matched = locateSessionContent(ref, sessionId, saved.locators);
            }
          }

          const address = readSessionContentAddress(ref);
          if (ref === sessionId || address !== undefined && address.turnId === undefined && address.journalSequence === undefined && address.eventId === undefined && address.attemptId === undefined && address.toolCallId === undefined) {
            const catalog = sessionMaterialCatalog(saved.view, saved.locators, sessionId, {}, input)!;
            const catalogBatch = associationBatch(input, [{ ref, role: "session_source_catalog_partial_not_original_requirements", catalog }]);
            batches.push(catalogBatch);
            aliases.push({ ref, recordRefs: catalogBatch.records.map(row => row.ref) });
            continue;
          }

          const refs = new Set<string>(), targetRefs = new Set<string>(), originalRequirements: string[] = [];

          for (const turnId of new Set(matched.flatMap(row => row.turnId === undefined ? [] : [row.turnId]))) {
            const original = decodeSessionContent(saved.view, { ...input, sessionId, turnId, through: saved.view.records.length - 1,
              publicTexts: new Map(matched.flatMap(row => row.publicText === undefined ? [] : [[row.journalSequence, row.publicText] as const])),
              envelopeSequences: matched.filter(row => row.turnId === turnId && row.eventId !== undefined).map(row => row.journalSequence) });
            if (!original.ok) return { ok: false, reason: "content_material_invalid" };

            batches.push(original.batch);
            original.batch.records.forEach(row => refs.add(row.ref));

            if (original.requiredIndex === undefined) originalRequirements.push(...original.batch.requirements.flatMap(requirement => requirement.sourceRefs));

            for (const locator of matched) for (const record of original.batch.records) {
              if (record.ref === locator.ref || record.ref.startsWith(`${locator.ref}:chunk:`)
                || record.ref === locator.viewRef || locator.viewRef !== undefined && record.ref.startsWith(`${locator.viewRef}:chunk:`)) targetRefs.add(record.ref);
            }
          }

          if (refs.size > 0) {
            if (!refs.has(ref)) {
              const exactEvent = matched.length === 1 && matched[0]!.eventId !== undefined;
              const canonicalAddress = readSessionContentAddress(ref);
              const turnAddress = taskId !== undefined || ref === sessionId || matched.every(row => row.turnId === ref)
                || isPureSessionTurnAddress(canonicalAddress);
              const targets = exactEvent ? [...targetRefs] : turnAddress ? [...new Set(originalRequirements)] : [...targetRefs];
              if (new Set(matched.map(row => row.turnId)).size <= 1 && targets.length > 0) aliases.push({ ref, recordRefs: targets });

              association.push({ ref, sessionId, locators: matched });
            }
          }
        }

        if (!input.enabled()) return { ok: false, reason: "content_material_unavailable" };

        if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

        if (association.length > 0) batches.push(associationBatch(input, association));

        const merged = mergeContentBatches(batches);

        return merged.ok ? mergeContentBatches([merged.value, { records: [], requirements: [], answers: [], materials: [], aliases }]) : merged;
      } catch (error) { return { ok: false, reason: error instanceof Error && error.message === "content_material_scope" ? "content_material_scope" : "content_material_unavailable" }; }
    },

    async readMaterial(ref, currentSignal, start = 0, maximumChars = 4096) {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

      if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 8192) return { ok: false, reason: "content_material_range_invalid" };

      try {
        if (readRequiredUserCatalogAddress(ref) !== undefined) {
          const catalog = await requiredCatalog(ref, currentSignal);
          if (catalog === undefined) return { ok: false, reason: "content_material_missing" };
          return requiredCatalogPage(catalog.index, catalog.address.sessionId, catalog.address.through, ref, start, maximumChars, currentSignal);
        }

        const address = readSessionContentAddress(ref), frozen = readSessionPublicTurnAddress(ref), taskId = readSessionTaskAddress(ref);
        const task = taskId === undefined ? undefined : await sourceForTask(taskId, currentSignal);
        if (taskId !== undefined && task === undefined) return { ok: false, reason: "content_material_missing" };

        let sessionId = task?.sessionId ?? frozen?.sessionId ?? address?.sessionId ?? input.sessionId, saved = task?.snapshot ?? await snapshotFor(sessionId, currentSignal);
        if (saved === undefined) return { ok: false, reason: "content_material_missing" };

        const publicTurnId = frozen?.turnId ?? (isPureSessionTurnAddress(address) ? address.turnId : undefined);
        if (publicTurnId !== undefined) {
          const page = readSessionPublicTurnMaterial({ ...input, view: saved.view, locators: saved.locators, sessionId,
            turnId: publicTurnId, requestedRef: ref, ...(frozen === undefined ? {} : { frozen }) }, start, maximumChars);
          if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
          if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };
          return page;
        }

        let matches = locateSessionContent(taskId === undefined ? ref : sessionContentAddress({ sessionId, turnId: taskId }), sessionId, saved.locators);
        const wholeTurn = taskId !== undefined || matches.every(row => row.turnId === ref);
        if (matches.length > 1 && wholeTurn && new Set(matches.map(row => row.turnId)).size === 1) {
          const originalUsers = matches.filter(row => {
            const record = saved!.view.records[row.journalSequence];
            return record?.type === "turn_input" || record?.type === "transcript_item" && record.payload.kind === "user";
          });
          if (originalUsers.length > 1) {
            const through = saved.view.records.length - 1, turnId = originalUsers[0]!.turnId!;
            const read = decodeSessionContent(saved.view, { ...input, sessionId, turnId, through });
            if (!read.ok) return read;
            const indexed = buildRequiredUserIndex({ sources: read.requiredSources, sessionId, turnId, through, scope: input.scope,
              subsystem: input.subsystem, maximumChars: input.maximumChars ?? 48000 });
            return indexed.ok ? requiredCatalogPage(indexed.value, sessionId, through, ref, start, maximumChars, currentSignal) : indexed;
          }

          if (originalUsers.length === 1 && taskId !== undefined) matches = originalUsers;
        }

        if (matches.length > 1 && address?.toolCallId !== undefined && new Set(matches.map(row => row.turnId)).size === 1) {
          const outputs = matches.filter(row => saved!.view.records[row.journalSequence]?.type === "transcript_item"
            && saved!.view.records[row.journalSequence]?.payload.kind === "tool_result");
          if (outputs.length === 1) matches = outputs;
        }

        if (matches.length === 0 && address === undefined) {
          const known = [...snapshots].flatMap(([id, snapshot]) => locateSessionContent(ref, id, snapshot.locators).map(locator => ({ id, snapshot, locator })));
          if (known.length === 1) {
            sessionId = known[0]!.id;
            saved = known[0]!.snapshot;
            matches = [known[0]!.locator];
          }
          else if (known.length > 1) return { ok: false, reason: "content_material_ambiguous" };
        }

        if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? "content_material_missing" : "content_material_ambiguous" };

        const sequence = matches[0]!.journalSequence, original = saved.view.records[sequence]!;
        const projected = sessionContentRecordView(original, input.scope, input.secrets, input.excludeToolNames, matches[0]!.publicText);
        if (projected === undefined || start > projected.record.text.length) return { ok: false, reason: "content_material_missing" };

        const { text, origin } = projected.record;
        const beginning = text.charCodeAt(start);
        if (start > 0 && beginning >= 0xdc00 && beginning <= 0xdfff) return { ok: false, reason: "content_material_range_invalid" };

        let end = Math.min(text.length, start + maximumChars);
        const point = text.charCodeAt(end);
        if (end < text.length && point >= 0xdc00 && point <= 0xdfff) end -= 1;

        if (end === start && start < text.length) return { ok: false, reason: "content_material_range_invalid" };

        if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

        if (currentSignal.aborted) return { ok: false, reason: "content_material_cancelled" };

        return { ok: true, value: { ref: projected.record.ref, sessionId, journalSequence: sequence, sourceHash: contentHashOf(text), start, end,
          totalChars: text.length, text: text.slice(start, end), origin, originalScope: input.scope, sourceRecordType: original.type,
          ...(projected.changed ? { coordinate: { runId: projected.record.runId, sequence: projected.record.sequence }, originalSource: projected.original } : {}) } };
      } catch { return { ok: false, reason: "content_material_unavailable" }; }
    },
  };

  return { ok: true, value: { batch: admitted.value, source, taskPurpose: decoded.taskPurpose, coverage: decoded.coverage } };
}

function associationBatch(input: SessionContentInput, mappings: readonly unknown[]): ContentMaterialBatch {
  const text = canonicalJson({ role: "exact_source_address_to_original_turn_association_not_semantic_question_identity", mappings });
  const ref = `session-content-association:${contentHashOf(text)}`;
  return { records: [{ ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text }], requirements: [], answers: [],
    materials: [{ id: ref, kind: "context", subsystem: input.subsystem, context: "Original journal and event addresses retain distinct coordinates; related turn text is recovered from the same source owner.",
      recordRefs: [ref], requirementIds: [], answerIds: [], links: { issueIds: [], topicIds: [], artifactRefs: [] } }] };
}
