import { createNdjsonSessionStore, recoverSessionRecordView } from "../../../../../adapters/session-store/ndjson.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { HermesSkillOpportunity } from "../contracts.js";
import { skillExperience } from "../experience.js";
import { journalSkillExperience, type JournalSkillExperience } from "./journal-experience.js";
import { toolCallIndexByResult } from "../../../../../protocol/tool-pairing.js";

export type HermesSessionSource = { readonly id: string; readonly path: string; readonly modifiedAtMs: number };

/** Runtime source selection; the control centre never supplies a lesson or task family. */
export function createJournalSkillOpportunity(options: {
  readonly workspaceRoot: string; readonly workspaceId: string;
  readonly sessions: () => readonly HermesSessionSource[];
  readonly source?: { readonly sessionId: string; readonly turnId: string };
  readonly accept?: (opportunity: HermesSkillOpportunity, signal: AbortSignal) => Promise<boolean>;
  readonly observe?: (source: { readonly transcript: Transcript; readonly history: Transcript;
    readonly records: readonly SessionRecord[] } & JournalSkillExperience) => void;
}) {
  return async (signal: AbortSignal): Promise<HermesSkillOpportunity | undefined> => {
    const sources = [...options.sessions()].filter(item => options.source === undefined || item.id === options.source.sessionId)
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs).slice(0, 32);

    for (const source of sources) {
      if (signal.aborted) return undefined;

      const store = createNdjsonSessionStore({ path: source.path });
      const journal = await store.readRecords();
      if (!journal.ok || journal.view.tornTail) throw new Error("hermes_source_journal_unavailable");

      // Source terminal, item sequences and recovered history must describe the
      // same append-journal snapshot, even if another turn appends after this read.
      const read = recoverSessionRecordView(journal.view);
      if (!read.ok) throw new Error("hermes_source_journal_unavailable");

      if (read.session.fingerprint.workspaceId !== options.workspaceId) continue;

      const terminals = journal.view.records.filter(item => item.type === "terminal"
        && (options.source === undefined || item.turnId === options.source.turnId)).slice(-12).reverse();

      for (const terminal of terminals) {
        const turnId = terminal.turnId;
        if (turnId === undefined) continue;

        // A later issue or settlement cannot change this terminal's source
        // state. Reuse the validated bytes, with the canonical recovery rules.
        const records = journal.view.records.filter(item => item.sequence <= terminal.sequence);
        const sourceRead = recoverSessionRecordView({ ...journal.view, records });
        if (!sourceRead.ok) throw new Error("hermes_source_journal_unavailable");

        const sequences = new Set(records.filter(item => item.turnId === turnId && item.type === "transcript_item")
          .map(item => item.payload.sequence));
        const transcript = sourceRead.session.transcript.filter(item => sequences.has(item.sequence));
        const lastSequence = Math.max(-1, ...transcript.map(item => item.sequence));
        const history = sourceRead.session.transcript.filter(item => item.sequence <= lastSequence);
        const observed = opportunityFromTranscript({ workspaceRoot: options.workspaceRoot, sessionId: source.id, turnId, transcript, history });
        const projected = journalSkillExperience({ records, history,
          source: { sessionId: source.id, turnId, terminalSequence: terminal.sequence }, maxChars: 39_000,
          terminal: { reason: typeof terminal.payload.reason === "string" ? terminal.payload.reason.slice(0, 128) : "unknown",
            finishReason: typeof terminal.payload.finishReason === "string" ? terminal.payload.finishReason.slice(0, 128) : "unknown",
            sessionUnresolvedEffects: sourceRead.session.reconcileRequired.length,
            interpretation: "Canonical execution terminal, not a verifier verdict or proof of a good deliverable." } });
        const opportunity: HermesSkillOpportunity = { ...observed, experience: projected.experience };
        if (options.accept === undefined || await options.accept(opportunity, signal)) {
          options.observe?.({ transcript, history, records, ...projected });
          return opportunity;
        }
      }
    }

    return undefined;
  };
}

/** Translate canonical execution facts into the unchanged legacy Evidence Capsule input. */
export function opportunityFromTranscript(input: {
  readonly workspaceRoot: string; readonly sessionId: string; readonly turnId: string; readonly transcript: Transcript; readonly history?: Transcript;
}): HermesSkillOpportunity {
  const userInputs = input.transcript.filter(item => item.kind === "user");
  const taskGoal = userInputs[0];
  const summary = input.transcript.filter(item => item.kind === "assistant_text").at(-1);
  const calls = toolCallIndexByResult(input.transcript);
  const matchingCall = (resultIndex: number) => {
    const call = input.transcript[calls.get(resultIndex) ?? -1], result = input.transcript[resultIndex];
    return call?.kind === "tool_call" && result?.kind === "tool_result" && call.name === result.name ? call : undefined;
  };

  return { trigger: "explicit", workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, turnId: input.turnId, mode: "agent",
    experience: skillExperience(input.history ?? input.transcript),
    taskGoal: taskGoal?.kind === "user" ? taskGoal.text : "",
    // Preserve subsequent user input, including explicit corrections, through
    // the existing native field. Keep the latest input within its 2000-char cap.
    learnRequest: userInputs.slice(1).map(item => item.text).join("\n\n").slice(-2000),
    resultSummary: summary?.kind === "assistant_text" ? summary.text : "",
    events: input.transcript.flatMap((item, index) => {
      if (item.kind !== "tool_result") return [];
      const call = matchingCall(index);
      if (call === undefined) return [];
      const args = call.arguments;
      const detail = args?.command ?? args?.path ?? args?.pattern;
      return [{ category: category(item.name), title: typeof detail === "string" ? `${item.name}: ${detail}` : item.name,
        status: item.outcome === "succeeded" ? "done" : item.outcome }];
    }),
    // These are observed tool failures, not a claim that verification passed.
    // Native evidence construction still owns redaction and per-entry limits.
    verification: input.transcript.flatMap((item, index) => item.kind === "tool_result" && item.outcome !== "succeeded" && matchingCall(index) !== undefined
      ? [`Observed ${item.outcome} ${item.name}: ${item.output}`] : []),
    fileHints: input.transcript.flatMap(item => item.kind === "tool_call" && typeof item.arguments.path === "string" ? [item.arguments.path] : []),
    // A terminal source proves this source execution settled. The journal has
    // no fact about a separate shadow/file review or native skill approvals.
    flags: { agentRunning: false } };
}

function category(name: string): string {
  if (name === "run_shell") return "command";
  if (/^(read|list|glob)/.test(name)) return "read";
  if (/^(grep|search)/.test(name)) return "search";
  if (/^(edit|apply_patch|notebook_edit)/.test(name)) return "edit";
  if (/^write/.test(name)) return "write";
  return "tool";
}
