import type { BoardStore } from "../../../../control/store-port.js";
import type { RewardV2Draft } from "../../../../reward/v2-facts.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import { toolCallIndexByResult } from "../../../../../protocol/tool-pairing.js";
import { hermesSkillRead, MAX_HERMES_SKILL_READ_FACTS } from "../skill-read.js";
import { hasNativeSkillCommit, skillApprovalDraft, skillInstructionLoadDrafts, type SkillInstructionLoad } from "../control/lifecycle.js";

type Append = (revision: number, draft: RewardV2Draft) => Promise<
  { readonly status: "written"; readonly revision: number } | { readonly status: "stale" }>;

type Options = { readonly board: Pick<BoardStore, "load">; readonly append: Append; readonly enabled: () => boolean };

/** Observe original receipts after success. All writes use the original Board
 * RewardV2 writer; a stale append re-reads the canonical source before one retry. */
export function createSkillLifecycleObserver(options: Options) {
  const appendDrafts = async (build: (state: Parameters<typeof skillInstructionLoadDrafts>[0]) => readonly RewardV2Draft[]) => {
    if (!options.enabled()) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!options.enabled()) return;

      const loaded = await options.board.load();
      if (!loaded.ok) throw new Error(loaded.reason);

      const drafts = build(loaded.state);
      if (drafts.length === 0) return;

      let revision = loaded.state.sequence, stale = false;

      for (const draft of drafts) {
        if (!options.enabled()) return;
        const outcome = await options.append(revision, draft);
        if (outcome.status === "stale") {
          stale = true;
          break;
        }
        revision = outcome.revision;
      }

      if (!stale) return;
    }

    throw new Error("hermes_lifecycle_stale");
  };
  return {
    recordApproval(input: Omit<Parameters<typeof skillApprovalDraft>[0], "board">) {
      if (!hasNativeSkillCommit(input.reply)) return Promise.resolve();
      return appendDrafts(board => {
        const draft = skillApprovalDraft({ ...input, board });
        return draft === undefined || board.rewardV2Facts?.some(fact => fact.id === draft.id) ? [] : [draft];
      });
    },
    recordTaskLoads(input: { readonly scope: string; readonly sessionId: string; readonly turnId: string;
      readonly transcript: Transcript; readonly records: readonly SessionRecord[] }) {
      const loads = instructionLoads(input);
      if (loads.length === 0) return Promise.resolve();

      return appendDrafts(board => {
        const prepared = skillInstructionLoadDrafts(board, input.scope, loads);
        if (prepared.status !== "ready") throw new Error(prepared.reason);
        return prepared.drafts;
      });
    },
  };
}

/** Journal timestamps and call pairing retain the actual task attribution.
 * Native counters, provision summaries and truncated replies are not reads. */
function instructionLoads(input: { readonly sessionId: string; readonly turnId: string;
  readonly transcript: Transcript; readonly records: readonly SessionRecord[] }): readonly SkillInstructionLoad[] {
  const calls = toolCallIndexByResult(input.transcript);
  return input.transcript.flatMap((item, index) => {
    if (item.kind !== "tool_result" || item.outcome !== "succeeded" || item.truncated) return [];

    const call = input.transcript[calls.get(index) ?? -1];
    if (call?.kind !== "tool_call" || call.name !== item.name) return [];

    const read = hermesSkillRead(call, item.output);
    if (read?.rawContentHash === undefined) return [];

    const journal = input.records.find(record => record.sessionId === input.sessionId && record.turnId === input.turnId
      && record.type === "transcript_item" && record.payload.sequence === item.sequence);

    return journal === undefined ? [] : [{ name: read.name, instructionHash: read.rawContentHash,
      renderedContentHash: read.contentHash, at: journal.at, sessionId: input.sessionId, turnId: input.turnId,
      toolCallId: item.toolCallId, transcriptSequence: item.sequence, journalSequence: journal.sequence }];
  // Same bounded positive-observation window as the source experience. Missing
  // earlier reads remain unknown; this never closes an adoption denominator.
  }).slice(-MAX_HERMES_SKILL_READ_FACTS);
}
