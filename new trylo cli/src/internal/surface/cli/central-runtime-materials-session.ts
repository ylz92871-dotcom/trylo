import { setImmediate } from "node:timers/promises";
import { isRuntimeFingerprint, type SessionRecordView } from "../../ports/session.js";
import type { CentralRuntimeMaterial, CentralRuntimeSnapshot, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readRuntimeSessionHeader } from "../../adapters/central-learning-runtime/session-header.js";
import { readCentralMaterialPageRef } from "../../integration/central-learning/deliberation-material.js";
import { readSessionContent, readSessionContentAddress, readSessionTaskAddress } from "../../integration/learning-content/sources/session.js";
import { locateSessionContent, sessionContentAddress, sessionContentLocators, SessionContentEnvelopeError, type SessionContentAddress,
  type SessionContentLocator } from "../../integration/learning-content/sources/session-address.js";
import { sessionContentRecordView, validateSessionContentJournal } from "../../integration/learning-content/sources/session-decode.js";
import type { SessionContentRead, SessionContentSource, SessionMaterialCatalog } from "../../integration/learning-content/sources/session-contract.js";
import type { CliContext } from "./context.js";
import { CENTRAL_LEARNING_CONTROL_TOOLS, centralLearningSessionLookup } from "./central-learning-sources.js";
import { isValidSessionId, listSessions, sessionPath, sessionsDir } from "./session-paths.js";
import { createRuntimeSessionWorkspaceAccess } from "./central-runtime-materials-scope.js";
import { readSessionPublicTurnAddress } from "../../integration/learning-content/sources/session-public-turn.js";
import { isNormalProviderReturnObservation, isProviderWaitObservation, providerPositiveNoteRef, providerReturnMatchesCapture,
  type VerifiedProviderPositiveNote } from "../../learning/central/runtime/provider-positive.js";
import { isContentValueCredentialSafe } from "../../integration/learning-content/content-confidentiality-leaf.js";

type Source = Extract<SessionContentRead, { ok: true }>["value"];

type Turn = { readonly turnId: string; readonly inputSequence: number; readonly through: number;
  readonly lastRef: string; readonly lastHash: string; readonly noticeRef: string };

type Journal = { readonly sessionId: string; readonly view: SessionRecordView; readonly turns: readonly Turn[];
  readonly locators: readonly SessionContentLocator[];
  readonly providerPositiveNotes: readonly VerifiedProviderPositiveNote[] };

type SourceQuery = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

type Reconsider = NonNullable<CentralRuntimeSnapshot["reconsider"]>;

export type RuntimeSessionMaterialsOptions = { readonly ctx: CliContext; readonly workspaceId: string;
  readonly enabled: () => boolean; readonly secrets?: readonly string[] };

export type RuntimeBusinessTurn = {
  readonly taskPurpose: string; readonly refs: readonly string[];
  /** Exact public records of a terminated normal turn, never partial provider output. */
  readonly handoffRefs?: readonly string[];
  readonly handoffAt?: string;
  readonly catalog: { readonly sessionId: string; readonly turnId: string; readonly noticeRef: string;
    readonly through: number; readonly lastSourceRef: string; readonly lastSourceHash: string;
    readonly entries: SessionMaterialCatalog["entries"]; readonly maximumShownEntries: number };
};

const FILE_BATCH = 32, DIRECTORY_ENTRIES = 8;

/** Header filtering reads no foreign journal body. Consumption belongs only to the caller's canonical source refs. */
export function createRuntimeSessionMaterials(options: RuntimeSessionMaterialsOptions) {
  const lookup = centralLearningSessionLookup(options.ctx), journals = new Map<string, Journal | undefined>();
  const failures = new Map<string, SessionContentEnvelopeError>();
  const workspace = createRuntimeSessionWorkspaceAccess(options);
  let current: Journal | undefined;
  const allowed = (signal: AbortSignal) => {
    if (!options.enabled() || signal.aborted) throw new Error("central_runtime_material_cancelled");
  };
  const load = async (id: string, signal: AbortSignal): Promise<Journal | undefined> => {
    allowed(signal);
    const failure = failures.get(id);
    if (failure !== undefined) throw failure;

    if (journals.has(id)) return journals.get(id);

    if (!isValidSessionId(id)) return undefined;

    const header = await readRuntimeSessionHeader(sessionPath(options.ctx.homeDir, options.ctx.env, id), id, signal);
    allowed(signal);

    if (!header.ok) {
      if (header.reason === "session_header_missing") return undefined;
      throw new Error(header.reason);
    }

    if (!workspace.accepts(header.value)) throw new Error("content_material_scope");

    const store = await lookup(id, signal);
    if (store === undefined) {
      journals.set(id, undefined);
      return undefined;
    }

    const result = await store.readRecords();
    allowed(signal);

    if (!result.ok) throw new Error(`central_runtime_journal_unavailable:${result.code}`);

    const checked = validateSessionContentJournal(result.view, id);
    if (!checked.ok) throw new Error(checked.reason);

    const fingerprint = result.view.records[0]!.payload.fingerprint;
    if (!isRuntimeFingerprint(fingerprint) || !workspace.matchesHeader(header.value, fingerprint)) throw new Error("content_material_scope");

    let locators: readonly SessionContentLocator[];

    try { locators = sessionContentLocators(result.view, id, CENTRAL_LEARNING_CONTROL_TOOLS,
      { scope: options.ctx.cwd, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) }); }
    catch (error) {
      if (error instanceof SessionContentEnvelopeError) failures.set(id, error);
      throw error;
    }

    const turns = normalTurns(result.view, options, locators);
    const journal = { sessionId: id, view: result.view, turns, locators, providerPositiveNotes: normalProviderPositiveNotes(result.view, turns, options) };

    journals.set(id, journal);
    return journal;
  };

  async function* localJournals(signal: AbortSignal): AsyncGenerator<Journal> {
    let files = 0;
    for (const entry of listSessions(options.ctx, sessionsDir(options.ctx.homeDir, options.ctx.env))) {
      allowed(signal);
      const header = await readRuntimeSessionHeader(entry.path, entry.id, signal);
      allowed(signal);

      if (!header.ok && header.reason !== "session_header_missing") throw new Error(header.reason);

      if (header.ok && workspace.accepts(header.value)) {
        try {
          const journal = await load(entry.id, signal);
          if (journal !== undefined) yield journal;
        }
        catch (error) {
          // Only this original decoder failure is isolated during automatic discovery.
          // Explicit reads still reject it; cancellation, scope and storage failures propagate.
          allowed(signal);
          if (!(error instanceof SessionContentEnvelopeError) || error.sessionId !== entry.id) throw error;
        }
      }

      if (++files % FILE_BATCH === 0) {
        await setImmediate();
        allowed(signal);
      }
    }
  }

  const forTask = async (id: string, signal: AbortSignal): Promise<readonly string[]> => {
    const matches: string[] = [];
    for await (const journal of localJournals(signal)) if (journal.turns.some(turn => turn.turnId === id)) matches.push(journal.sessionId);
    return matches;
  };
  const source = async (journal: Journal, turn: Turn, signal: AbortSignal): Promise<Source> => {
    const read = await readSessionContent({ session: { readRecords: async () => ({ ok: true, view: journal.view }) },
      sessionId: journal.sessionId, turnId: turn.turnId, scope: options.ctx.cwd, subsystem: "collaboration", enabled: options.enabled,
      through: turn.through, maximumChars: 65536, maximumRecords: 32, excludeToolNames: CENTRAL_LEARNING_CONTROL_TOOLS,
      compatibleWorkspaceIds: workspace.compatibleWorkspaceIds,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }), lookupSessionsForTask: forTask,

      lookupSession: async (id, cancellation) => {
        const found = await load(id, cancellation);
        return found === undefined ? undefined : { readRecords: async () => ({ ok: true, view: found.view }) };
      } }, signal);
    if (!read.ok) throw new Error(read.reason);

    return read.value;
  };
  const directory = async (journal: Journal, turn: Turn, signal: AbortSignal): Promise<RuntimeBusinessTurn> => {
    const selected = await source(journal, turn, signal);
    const head = await selected.source.listMaterials(signal, { maximumItems: 1 });
    if (!head.ok) throw new Error(head.reason);

    const catalog = await selected.source.listMaterials(signal, { start: Math.max(0, head.value.available - DIRECTORY_ENTRIES), maximumItems: DIRECTORY_ENTRIES });
    if (!catalog.ok) throw new Error(catalog.reason);

    const entries = catalog.value.entries.filter(row => row.turnId === turn.turnId);

    return { taskPurpose: selected.taskPurpose, refs: [sessionContentAddress({ sessionId: journal.sessionId, journalSequence: turn.inputSequence })],
      handoffRefs: publicHandoffRefs(journal, turn, options),
      ...(journal.view.records[turn.through]?.type === "terminal" ? { handoffAt: journal.view.records[turn.through]!.at } : {}),
      catalog: { sessionId: journal.sessionId, turnId: turn.turnId, noticeRef: turn.noticeRef, through: turn.through,
        lastSourceRef: turn.lastRef, lastSourceHash: turn.lastHash, entries, maximumShownEntries: DIRECTORY_ENTRIES } };
  };
  const catalogs = async (signal: AbortSignal, consumed: readonly string[] = [], maximum = 8, considered: readonly string[] = []) => {
    const seen = new Set(consumed), items: RuntimeBusinessTurn[] = [], consideredItems: RuntimeBusinessTurn[] = [];
    const result = (hasMore: boolean) => ({ items, hasMore, consideredItems: consideredItems.slice(0, Math.max(0, maximum - items.length)) });
    const versions = considered.flatMap(ref => {
      const version = readSessionPublicTurnAddress(ref);
      return version === undefined ? [] : [{ ref, version }];
    });

    for await (const journal of localJournals(signal)) {
      for (const turn of [...journal.turns].sort((left, right) => right.through - left.through)) {
        if (seen.has(turn.noticeRef)) continue;

        const candidates = versions.filter(row => row.version.sessionId === journal.sessionId && row.version.turnId === turn.turnId
          && row.version.through === turn.through);
        let known = false;

        if (candidates.length > 0) {
          const original = await source(journal, turn, signal);
          for (const candidate of candidates) {
            // The original reader recomputes the complete public collection's
            // hash. Matching names/positions alone cannot hide changed bytes.
            const checked = await original.source.readMaterial(candidate.ref, signal, 0, 1);
            if (checked.ok) {
              known = true;
              break;
            }
            if (checked.reason !== "content_material_conflict") throw new Error(checked.reason);
          }
        }

        // This suppresses only automatic discovery of the same source version.
        // Exact reads and continuation addresses still use the original reader.
        if (known) {
          if (consideredItems.length < maximum) consideredItems.push(await directory(journal, turn, signal));
          continue;
        }

        if (items.length === maximum) return result(true);

        current ??= journal;
        items.push(await directory(journal, turn, signal));
      }
    }

    return result(false);
  };
  const reconsider = async (query: SourceQuery | undefined, signal: AbortSignal): Promise<Reconsider> => {
    if (!query?.purposes?.length) return [];
    const contexts: Journal[] = [];
    for await (const journal of localJournals(signal)) contexts.push(journal);
    allowed(signal);
    return originalContextChanges(contexts, query, options);
  };
  const reader: Pick<SessionContentSource, "readMaterial"> = {
    async readMaterial(ref, signal, start, maximumChars) {
      try {
        allowed(signal);
        const page = readCentralMaterialPageRef(ref);
        if (page !== undefined) {
          if (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) return { ok: false, reason: "content_material_range_invalid" };
          return reader.readMaterial(page.ref, signal, page.start + (start ?? 0), maximumChars);
        }

        const frozen = readSessionPublicTurnAddress(ref);
        const address: SessionContentAddress | undefined = readSessionContentAddress(ref)
          ?? (frozen === undefined ? undefined : { sessionId: frozen.sessionId, turnId: frozen.turnId });
        const taskId = readSessionTaskAddress(ref);
        let selected = address === undefined ? current : await load(address.sessionId, signal);
        let locatedTurnId: string | undefined;

        if (address === undefined && taskId === undefined) {
          const known = [...journals.values()].flatMap(journal => journal === undefined ? []
            : locateSessionContent(ref, journal.sessionId, journal.locators).map(locator => ({ journal, locator })));
          if (known.length > 1) return { ok: false, reason: "content_material_ambiguous" };
          if (known[0] !== undefined) {
            selected = known[0].journal;
            locatedTurnId = known[0].locator.turnId;
          }
        }

        if (taskId !== undefined) {
          const ids = await forTask(taskId, signal);
          if (ids.length !== 1) return { ok: false, reason: ids.length === 0 ? "content_material_missing" : "content_material_ambiguous" };
          selected = await load(ids[0]!, signal);
        }

        if (selected === undefined) return { ok: false, reason: "content_material_missing" };

        const lookupRef = taskId === undefined ? ref : sessionContentAddress({ sessionId: selected.sessionId, turnId: taskId });
        const matched = locateSessionContent(lookupRef, selected.sessionId, selected.locators);
        if (matched.some(row => row.turnId !== undefined && !selected!.turns.some(turn => turn.turnId === row.turnId))) return { ok: false, reason: "content_material_scope" };

        const turnId = address?.turnId ?? (address?.journalSequence === undefined ? undefined : selected.view.records[address.journalSequence]?.turnId)
          ?? taskId ?? locatedTurnId ?? [...selected.turns].reverse()[0]?.turnId;
        const turn = selected.turns.find(row => row.turnId === turnId);
        if (turn === undefined) return { ok: false, reason: "content_material_missing" };

        return (await source(selected, turn, signal)).source.readMaterial(ref, signal, start, maximumChars);
      } catch (error) {
        // A scope, cancellation or unavailable source stays terminal; it never falls through as an invented empty source.
        return { ok: false, reason: error instanceof Error ? error.message : "content_material_unavailable" };
      }
    },
  };

  return { catalogs, reader, reconsider,
    sourceFailures: (consumed: readonly string[] = []): readonly CentralRuntimeMaterial[] => [...failures.values()].flatMap(failure => {
      const text = canonicalJson({ role: "host_normal_turn_source_catalog_not_read_body", status: "unavailable",
        sessionId: failure.sessionId, journalSequence: failure.journalSequence, reason: failure.message, validationCode: failure.validationCode,
        address: sessionContentAddress({ sessionId: failure.sessionId, journalSequence: failure.journalSequence }),
        interpretation: "Original source rejected by its protocol decoder; no source body was delivered. Other sessions remain available." });
      const ref = `central-business-catalog:${contentHashOf(text)}`;
      return consumed.includes(ref) ? [] : [{ ref, kind: "source", text, sourceRefs: [] }];
    }),
    /** Only already discovered, checksum-validated journals; this method performs no I/O or discovery. */
    providerPositiveNotes: (): readonly VerifiedProviderPositiveNote[] => latestProviderPositiveNotes([...journals.values()]
      .flatMap(journal => journal?.providerPositiveNotes ?? [])),
  };
}

function latestProviderPositiveNotes(notes: readonly VerifiedProviderPositiveNote[]): readonly VerifiedProviderPositiveNote[] {
  const unique = new Map<string, VerifiedProviderPositiveNote>();
  for (const note of notes) if (!unique.has(note.ref)) unique.set(note.ref, note);
  return [...unique.values()].sort((left, right) => Date.parse(right.finish.at) - Date.parse(left.finish.at)
    || right.finish.sequence - left.finish.sequence || left.ref.localeCompare(right.ref)).slice(0, 8);
}

/** Metadata is accepted only at its original producer positions in an eligible
 * normal turn. User/transcript claims and terminal text supply no evidence. */
function normalProviderPositiveNotes(view: SessionRecordView, turns: readonly Turn[], options: RuntimeSessionMaterialsOptions): readonly VerifiedProviderPositiveNote[] {
  const normal = new Set(turns.map(turn => turn.turnId));
  const starts = new Map<string, SessionRecordView["records"][number]>(), ambiguous = new Set<string>();
  const notes: VerifiedProviderPositiveNote[] = [];

  for (const row of view.records) {
    const turnId = row.turnId;
    if (turnId === undefined || !normal.has(turnId) || !validJournalTime(row.at)) continue;

    if (row.type === "turn_start") {
      if (starts.has(turnId)) ambiguous.add(turnId);
      else starts.set(turnId, row);
      continue;
    }

    if (row.type !== "terminal" || ambiguous.has(turnId)) continue;

    const request = starts.get(turnId), capture = request?.payload.providerWaitObservation, returned = row.payload.providerReturnObservation;
    if (request === undefined || request.sequence >= row.sequence || !isProviderWaitObservation(capture)
      || !isNormalProviderReturnObservation(returned) || !providerReturnMatchesCapture(capture, returned)
      || capture.sessionId !== row.sessionId || capture.turnId !== turnId) continue;

    const body = { capture, returned, request: { sequence: request.sequence, at: request.at }, finish: { sequence: row.sequence, at: row.at } };
    const note = { ref: providerPositiveNoteRef(body), ...body };
    if (isContentValueCredentialSafe(note, options.secrets ?? [])) notes.push(note);
  }

  return latestProviderPositiveNotes(notes);
}

function validJournalTime(at: string): boolean {
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at));
}

function normalTurns(view: SessionRecordView, options: RuntimeSessionMaterialsOptions, locators: readonly SessionContentLocator[]): readonly Turn[] {
  const denied = new Set(view.records.filter(row => row.type === "turn_start" && row.payload.userSourceAvailable === false).map(row => row.turnId));
  // The original locator owns tool-call/result correlation, including unnamed result envelopes.
  const eligible = new Map(locators.map(row => [row.journalSequence, row]));
  const inputs = new Map<string, number>(), turns = new Map<string, Turn>();

  for (const row of view.records) {
    const turnId = row.turnId;
    if (turnId === undefined || denied.has(turnId)) continue;

    if (!inputs.has(turnId) && (row.type === "turn_input" || row.type === "transcript_item" && row.payload.kind === "user")) inputs.set(turnId, row.sequence);

    const inputSequence = inputs.get(turnId);
    if (inputSequence === undefined) continue;

    const locator = eligible.get(row.sequence);
    if (locator === undefined) continue;

    const publicView = sessionContentRecordView(row, options.ctx.cwd, options.secrets, CENTRAL_LEARNING_CONTROL_TOOLS, locator.publicText);
    if (publicView === undefined || !publicView.record.text.trim()) continue;

    const identity = { sessionId: row.sessionId, turnId, journalSequence: row.sequence, sourceHash: publicView.original.sourceHash };

    turns.set(turnId, { turnId, inputSequence, through: row.sequence, lastRef: publicView.record.ref,
      lastHash: publicView.original.sourceHash, noticeRef: `central-business-turn:${contentHashOf(identity)}` });
  }

  return [...turns.values()];
}

function publicHandoffRefs(journal: Journal, turn: Turn, options: RuntimeSessionMaterialsOptions): readonly string[] {
  if (journal.view.records[turn.through]?.type !== "terminal") return [];

  const locators = [...journal.locators].reverse().filter(row => row.turnId === turn.turnId && row.journalSequence <= turn.through);

  return ["assistant_text", "tool_result"].flatMap(role => {
    const latest = locators.find(locator => {
      const row = journal.view.records[locator.journalSequence]!;
      return row.type === "transcript_item" && row.payload.kind === role
        && (sessionContentRecordView(row, options.ctx.cwd, options.secrets, CENTRAL_LEARNING_CONTROL_TOOLS)?.record.text.trim().length ?? 0) > 0;
    });
    return latest === undefined ? [] : [sessionContentAddress({ sessionId: journal.sessionId, turnId: turn.turnId, journalSequence: latest.journalSequence })];
  });
}

/** The source supplies original context changes, never a semantic judgement that two tasks or goals are equivalent. */
function originalContextChanges(journals: readonly Journal[], query: SourceQuery, options: RuntimeSessionMaterialsOptions): Reconsider {
  const consumed = new Set(query.sourceRefs), changed: Reconsider[number][] = [];

  for (const ref of query.sourceRefs) {
    const original = originalContextAddress(ref);
    if (original?.kind === "session") consumed.add(original.ref);
  }

  for (const purpose of query.purposes ?? []) {
    const anchors = new Map<Journal, number>();

    for (const ref of purpose.sourceRefs) {
      const original = originalContextAddress(ref);
      if (original === undefined) continue;

      const candidates = original.kind === "session" ? journals.filter(journal => journal.sessionId === original.sessionId)
        : journals.filter(journal => journal.turns.some(turn => turn.turnId === original.taskId));
      if (candidates.length !== 1) continue; // A task address without one original session cannot establish a relationship.

      const journal = candidates[0]!, address = original.kind === "session" ? original.ref
        : sessionContentAddress({ sessionId: journal.sessionId, turnId: original.taskId });
      const matched = locateSessionContent(address, journal.sessionId, journal.locators)
        .filter(row => row.turnId !== undefined && journal.turns.some(turn => turn.turnId === row.turnId));
      if (matched.length > 0) anchors.set(journal, Math.max(anchors.get(journal) ?? -1, ...matched.map(row => row.journalSequence)));
    }

    const refs: string[] = [];

    for (const [journal, through] of anchors) for (const row of journal.view.records) {
      if (row.sequence <= through || row.turnId === undefined || !journal.turns.some(turn => turn.turnId === row.turnId)
        || !(row.type === "turn_input" || row.type === "transcript_item" && row.payload.kind === "user")) continue;
      const source = sessionContentRecordView(row, options.ctx.cwd, options.secrets, CENTRAL_LEARNING_CONTROL_TOOLS);
      const address = sessionContentAddress({ sessionId: journal.sessionId, journalSequence: row.sequence });
      if (source !== undefined && source.record.text.trim() && !consumed.has(address) && !consumed.has(source.record.ref)) refs.push(address);
    }

    if (refs.length > 0) changed.push({ subject: purpose.subject, sourceRefs: [...new Set(refs)], reason: "original_user_context_changed" });
  }

  return changed;
}

function originalContextAddress(ref: string, depth = 0): { readonly kind: "session"; readonly ref: string; readonly sessionId: string }
  | { readonly kind: "task"; readonly taskId: string } | undefined {
  if (depth > 4) return undefined;
  try {
    const page = readCentralMaterialPageRef(ref);
    if (page !== undefined) return originalContextAddress(page.ref, depth + 1);
    const session = readSessionContentAddress(ref);
    if (session !== undefined) return { kind: "session", ref, sessionId: session.sessionId };
    const taskId = readSessionTaskAddress(ref);
    return taskId === undefined ? undefined : { kind: "task", taskId };
  } catch { return undefined; } // Malformed and opaque identities establish no context link.
}
