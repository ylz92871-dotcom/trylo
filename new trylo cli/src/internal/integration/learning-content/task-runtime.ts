import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { ProviderPort } from "../../ports/provider.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { mergeContentBatches } from "../../learning/central/content/material.js";
import { createLearningContentService } from "./service.js";
import { readSessionContent, sessionSourceAddressesForIssue } from "./sources/session.js";
import { contentSubsystem } from "./sources/artifact.js";
import { createAutomaticBoardContentSource } from "./sources/board.js";
import { readAutomaticContentFeedback } from "./sources/feedback-automatic.js";
import { recordContentContextDelivery } from "./sources/adoption-receipt.js";
import { buildTaskContentReference, withTaskContentReference, type TaskContentReference } from "./task-reference.js";
import type { NormalTaskContentOptions, NormalTaskContentPrepared, NormalTaskContentRuntime } from "./task-runtime-contract.js";
import type { ContentMaterialSource } from "../../learning/central/content/material-contract.js";
import { createTaskSourcePageReader } from "./task-source-pages.js";
import { readDomainFeedbackMaterial } from "./sources/domain-feedback.js";
import { contentAdmissionForIssue } from "./admission.js";
import { createCentralAdvisorySourceAccess } from "./sources/advisory-access.js";
import type { TaskCentralAdvisory } from "./sources/native-central-advisory.js";
import { recordAdvisoryUseReport } from "./sources/advisory-receipt.js";
import { createAdvisoryFeedbackRefresh } from "./advisory-feedback-refresh.js";

/** Ordinary task/session source composition. No provider calls, scheduling loop, grants or assets are minted. */
export function createNormalTaskContentRuntime(options: NormalTaskContentOptions): NormalTaskContentRuntime & {
  referenceForTask(maximumChars: number, signal: AbortSignal): Promise<{ readonly ok: true; readonly value: TaskContentReference | undefined }
    | { readonly ok: false; readonly reason: string }>;
  withProvider(provider: ProviderPort, reference: TaskContentReference | undefined): ProviderPort;
  withAutomaticReferences(provider: ProviderPort, maximumChars: number): ProviderPort;
  readAdvisory(input: { readonly ref: string; readonly version?: string; readonly start?: number; readonly maximumChars?: number }, signal: AbortSignal):
    Promise<{ readonly ok: true; readonly advisoryRead: { readonly ref: string; readonly version: string; readonly start: number;
      readonly end: number; readonly totalChars: number; readonly sourceHash: string; readonly text: string } }
      | { readonly ok: false; readonly reason: string }>;
  reportAdvisory(input: { readonly toolCallId: string; readonly ref: string; readonly version: string;
    readonly change: string; readonly reason: string }, signal: AbortSignal): ReturnType<typeof recordAdvisoryUseReport>;
  refreshAdvisoryFeedback(signal: AbortSignal): ReturnType<ReturnType<typeof createAdvisoryFeedbackRefresh>>;
} {
  const board = createBoardReader(options.boardRoot);
  const service = createLearningContentService(options);
  const refreshAdvisoryFeedback = createAdvisoryFeedbackRefresh(options);
  const sourceReaders = new Map<string, ReturnType<typeof createTaskSourcePageReader>>();
  let latestReader: ReturnType<typeof createTaskSourcePageReader> | undefined;
  let frozenAdvisories: readonly TaskCentralAdvisory[] = [];
  const runtime: NormalTaskContentRuntime = {
    identity: { boardRoot: options.boardRoot, scope: options.scope, domain: options.domain, sessionId: options.sessionId, turnId: options.turnId },
    currentAdmission: (issueId, signal) => contentAdmissionForIssue({ boardRoot: options.boardRoot, scope: options.scope,
      domain: options.domain, issueId, enabled: options.enabled, signal,
      sessionSource: { session: options.session, sessionId: options.sessionId,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }) },
      ...(options.domainFeedback === undefined ? {} : { domainFeedback: options.domainFeedback }) }),

    async prepare(input, signal): Promise<NormalTaskContentPrepared> {
      if (!options.enabled()) return { ok: false, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      // Reuse these captured Board and session views throughout packet preparation.
      const [loadedRead, sessionRead] = await Promise.allSettled([board.load(), options.session.readRecords()]);

      if (loadedRead.status === "rejected" || sessionRead.status === "rejected") return { ok: false, reason: "content_material_unavailable" };

      const loaded = loadedRead.value, records = sessionRead.value;
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      if (!records.ok) return { ok: false, reason: records.code };

      if (!options.enabled()) return { ok: false, reason: "collect_disabled" };

      const source = await readSessionContent({ session: { readRecords: async () => records }, sessionId: options.sessionId,
        turnId: options.turnId, scope: options.scope, subsystem: contentSubsystem(options.domain), enabled: options.enabled,
        maximumChars: 24000,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        ...(options.lookupSession === undefined ? {} : { lookupSession: options.lookupSession }),
        ...(options.lookupSessionsForTask === undefined ? {} : { lookupSessionsForTask: options.lookupSessionsForTask }),
        ...(options.excludeToolNames === undefined ? {} : { excludeToolNames: options.excludeToolNames }) }, signal);
      if (!source.ok) return source;

      const references = createAutomaticBoardContentSource({ board: { load: async () => loaded }, scope: options.scope,
        domain: options.domain, taskPurpose: source.value.taskPurpose, enabled: options.enabled, maximumChars: 12000,
        ...(options.recall === undefined ? {} : { recall: options.recall }),
        advisoryAccess: createCentralAdvisorySourceAccess({ board: loaded.state, scope: options.scope,
          sessionSource: source.value.source, enabled: options.enabled,
          ...(options.nativeAccess === undefined ? {} : { nativeAccess: options.nativeAccess }) }),
        nativeAccess: { ...options.nativeAccess, inspectionIssueIds: [...(options.nativeAccess?.inspectionIssueIds ?? []),
          ...(input.issueId === undefined ? [] : [input.issueId])] } });
      const recalled = await references.readTaskReferences(signal);
      if (!recalled.ok) return recalled;

      const selected = new Set(recalled.value.coverage.selectedCandidates);
      const artifacts = recalled.value.mappings.filter(row => selected.has(`asset:${row.ref}`) || row.contentFactIds.some(id => selected.has(id)))
        .map(row => ({ id: row.ref, version: row.version }));
      const feedback = await readAutomaticContentFeedback({ board: loaded.state, view: records.view, scope: options.scope,
        domain: options.domain, sessionId: options.sessionId, enabled: options.enabled, signal,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        materialArtifactRefs: artifacts, materialMaximumChars: 10000,
        ...(input.issueId === undefined ? {} : { issueId: input.issueId }) });
      if (!feedback.ok) return feedback;

      const issueIds = [...new Set([...(input.issueId === undefined ? [] : [input.issueId]),
        ...recalled.value.batch.materials.flatMap(material => material.links.issueIds),
        ...feedback.value.batch.materials.flatMap(material => material.links.issueIds)])];
      const domainFeedback = options.domainFeedback === undefined ? undefined : await readDomainFeedbackMaterial({
        domainFeedback: options.domainFeedback, board: loaded.state, issueIds, scope: options.scope, domain: options.domain,
        signal, maximumChars: 12000, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
      if (domainFeedback !== undefined && !domainFeedback.ok) return domainFeedback;

      const domainMaterial = domainFeedback?.ok ? domainFeedback.value : undefined;
      // Keep the packet linked to the exact readers that supplied its source pages.
      const pages = createTaskSourcePageReader({ session: source.value.source, board: references, feedback: feedback.value,
        ...(domainMaterial === undefined ? {} : { domainFeedback: domainMaterial }) });

      latestReader = pages;
      const seed = mergeContentBatches([source.value.batch, recalled.value.batch, feedback.value.batch,
        ...(domainMaterial === undefined ? [] : [domainMaterial.batch])]);
      if (!seed.ok) return seed;

      const composed: ContentMaterialSource = { async retrieve(query, cancellation) {
        const session = await source.value.source.retrieve(query, cancellation);
        if (!session.ok) return session;
        const related = await references.retrieve(query, cancellation);
        if (!related.ok) return related;
        return mergeContentBatches([session.value, related.value]);
      } };
      const originalIssue = input.issueId === undefined ? undefined : loaded.state.learningIssues?.find(issue => issue.scope === options.scope && issue.issueId === input.issueId);
      const requestedRefs = originalIssue === undefined ? [] : sessionSourceAddressesForIssue(originalIssue, loaded.state);
      const packet = await service.prepare({ ...seed.value, requestedRefs,
        ...(input.issueId === undefined ? {} : { issueId: input.issueId }) }, signal, composed);
      if (packet.ok) {
        sourceReaders.set(packet.value.packetId, pages);
        if (sourceReaders.size > 32) sourceReaders.delete(sourceReaders.keys().next().value!);
      }

      return packet.ok ? { ok: true, value: { packet: packet.value, coverage: { session: source.value.coverage,
        references: recalled.value.coverage, ...(domainMaterial === undefined ? {} : { domainFeedback: domainMaterial.coverage }) },
        ...(recalled.value.advisories === undefined ? {} : { advisories: recalled.value.advisories }),
        ...(recalled.value.advisoryCatalog === undefined ? {} : { advisoryCatalog: recalled.value.advisoryCatalog }) } } : packet;
    },

    async publish(packet, output, expectedWriteRevision) {
      const loaded = await board.load();
      if (!loaded.ok) return { status: "rejected", reason: loaded.reason };
      return service.publish(packet, output, expectedWriteRevision ?? loaded.state.sequence);
    },

    async readMaterial(input, signal) {
      if (!options.enabled()) return { ok: false, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false, reason: "content_cancelled" };

      if (input.packet.scope !== options.scope || input.packet.domain !== options.domain) return { ok: false, reason: "content_owner_mismatch" };

      let pages = sourceReaders.get(input.packet.packetId);
      if (pages === undefined) {
        const refreshed = await runtime.prepare(input.packet.focus === undefined ? {} : { issueId: input.packet.focus.issueId }, signal);
        if (!refreshed.ok && refreshed.reason !== "content_material_capacity") return refreshed;
        pages = refreshed.ok ? sourceReaders.get(refreshed.value.packet.packetId) : latestReader;
      }

      if (pages === undefined) return { ok: false, reason: "content_material_unavailable" };

      return pages.read(input.evidenceRef, signal, input.start, input.maximumChars);
    },
  };

  async function referenceForTask(maximumChars: number, signal: AbortSignal) {
      const prepared = await runtime.prepare({}, signal);
      if (!prepared.ok) return prepared;

      if (!options.enabled()) return { ok: false as const, reason: "collect_disabled" };

      const archive = await service.read(), packet = prepared.value.packet;

      frozenAdvisories = prepared.value.advisoryCatalog ?? [];
      const refs = archive.records.filter(record => packet.records.some(row => row.runId === record.factId)).map(record => ({
        contentFactId: record.factId, processId: record.output.processId,
        questionRefs: packet.records.filter(row => row.runId === record.factId && row.ref.startsWith("content-question:")).map(row => row.ref),
        answerRefs: packet.records.filter(row => row.runId === record.factId && row.ref.startsWith("content-answer:")).map(row => row.ref),
      }));

      return { ok: true as const, value: buildTaskContentReference(packet, { ...runtime.identity, maximumChars, refs,
        ...(prepared.value.advisories === undefined ? {} : { advisories: prepared.value.advisories }),
        ...(prepared.value.advisoryCatalog === undefined ? {} : { advisoryCatalog: prepared.value.advisoryCatalog }) }) };
  }

  function withProvider(provider: ProviderPort, reference: TaskContentReference | undefined): ProviderPort {
      return withTaskContentReference(provider, reference, { enabled: options.enabled, async delivered(input) {
        if (input.reference.refs.length + input.reference.artifactRefs.length + (input.reference.advisoryRefs?.length ?? 0) === 0) return { ok: true };

        if (input.reference.advisoryRefs?.some(ref => !frozenAdvisories.some(row => row.ref === ref.ref && row.version === ref.version))) {
          return { ok: false, reason: "advisory_delivery_not_in_frozen_source" };
        }

        const written = await recordContentContextDelivery({ session: options.session, sessionId: options.sessionId, turnId: options.turnId,
          attemptId: input.attemptId, refs: input.reference.refs, artifactRefs: input.reference.artifactRefs,
          ...(input.reference.advisoryRefs === undefined ? {} : { advisoryRefs: input.reference.advisoryRefs }),
          materialHash: sha256Hex(input.reference.text), now: options.now });

        return written.status === "recorded" ? { ok: true } : { ok: false, reason: written.reason };
      } });
  }

  return { ...runtime, referenceForTask, withProvider, refreshAdvisoryFeedback,

    async readAdvisory(input, signal) {
      if (!options.enabled() || signal.aborted) return { ok: false, reason: "advisory_read_cancelled" };

      const source = frozenAdvisories.find(row => input.version === undefined ? row.ref === input.ref || row.version === input.ref
        : row.ref === input.ref && row.version === input.version);
      if (source === undefined) return { ok: false, reason: "advisory_not_in_current_handoff" };

      const start = input.start ?? 0, maximumChars = input.maximumChars ?? 4096;
      if (!Number.isSafeInteger(start) || start < 0 || start > source.text.length || !Number.isSafeInteger(maximumChars)
        || maximumChars < 1 || maximumChars > 8192) return { ok: false, reason: "advisory_read_range_invalid" };

      let end = Math.min(source.text.length, start + maximumChars);
      const point = source.text.charCodeAt(end);
      if (end < source.text.length && point >= 0xdc00 && point <= 0xdfff) end -= 1;

      return { ok: true, advisoryRead: { ref: source.ref, version: source.version, start, end,
        totalChars: source.text.length, sourceHash: contentHashOf(source.text), text: source.text.slice(start, end) } };
    },

    reportAdvisory: (input, signal) => !options.enabled() ? Promise.resolve({ status: "rejected" as const, reason: "collect_disabled" })
      : recordAdvisoryUseReport({ session: options.session, sessionId: options.sessionId, turnId: options.turnId,
        toolCallId: input.toolCallId, advisory: { ref: input.ref, version: input.version }, change: input.change,
        reason: input.reason, now: options.now }, signal),

    /** Resolve only after the normal runner has journalled its current input, immediately before send. */
    withAutomaticReferences(provider, maximumChars) {
      let frozen: { readonly userInputHash: string; readonly value: TaskContentReference | undefined } | undefined;
      return { ...provider, ...(provider.fork === undefined ? {} : { fork: provider.fork.bind(provider) }),

        async *stream(request, signal) {
          if (!options.enabled() || signal.aborted) {
            yield* provider.stream(request, signal);
            return;
          }

          let reference;
          // Keep a task's reference set stable through tool iterations. Otherwise delivery receipts
          // would recursively become new reference material. New user input starts a fresh boundary.
          const userInputHash = contentHashOf(request.messages.filter(message => message.role === "user"));

          try {
            reference = frozen?.userInputHash === userInputHash ? { ok: true as const, value: frozen.value }
              : await referenceForTask(maximumChars, signal);
            if (reference.ok) frozen = { userInputHash, value: reference.value };
          }
          catch { reference = { ok: false as const, reason: "content_reference_source_unavailable" }; }

          if (!reference.ok) yield { type: "warning", code: "content_reference_unavailable",
            message: "Prior learning references are unavailable for this request; ordinary execution can continue." };

          yield* withProvider(provider, reference.ok ? reference.value : undefined).stream(request, signal);
        } };
    },
  };
}
