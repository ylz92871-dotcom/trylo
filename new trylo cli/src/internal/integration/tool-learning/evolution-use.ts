import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { readToolEvolutionCandidate, candidateFromBoard } from "./evolution-reader.js";
import { openFrozenToolUse, type FrozenUseOptions, type FrozenUseMount, type FrozenUseSelection } from "./frozen-use.js";

export type CandidateUseOptions = FrozenUseOptions;
export type CandidateUseMount = FrozenUseMount;

/** One opt-in lab version. Production packages use a separate receipt/activation reader. */
export async function openToolCandidateUse(options: CandidateUseOptions) {
  const read = async () => {
    const selected = await readToolEvolutionCandidate(options.boardRoot, options.versionId);
    if (!selected.ok) return selected;
    const value: FrozenUseSelection = { ok: true, candidate: selected.artifact.candidate, scope: selected.artifact.request.scope,
      contentHash: contentHashOf({ type: "tool_evolution_candidate", ...selected.artifact }),
      nameDigest: selected.artifact.verification.candidateHash, label: "Experimental frozen candidate" };
    return value;
  };
  const selected = await read();
  return selected.ok ? openFrozenToolUse(options, selected, read) : selected;
}

export async function readToolCandidateUses(boardRoot: string, versionId: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };
  if (!loaded.state.assets.some(item => item.versionId === versionId)) return { ok: false as const, code: "candidate_not_found", message: "candidate version is absent" };
  return { ok: true as const, records: (loaded.state.toolUses ?? []).filter(item => item.versionId === versionId) };
}

/** Withdraw a lab candidate; already admitted production packages keep their own lifecycle. */
export async function withdrawToolCandidate(boardRoot: string, versionId: string, issuedAt: string) {
  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };
    const asset = loaded.state.assets.find(item => item.versionId === versionId);
    const proposal = loaded.state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
    if (asset === undefined || proposal === undefined) return { ok: false as const, code: "candidate_not_found", message: "candidate version is absent" };
    if (proposal.lifecycle === "rejected") return { ok: true as const, versionId, state: "withdrawn" as const, changed: false };
    const candidate = candidateFromBoard(loaded.state, versionId);
    if (!candidate.ok) return candidate;
    if (proposal.lifecycle !== "evaluating") return { ok: false as const, code: "candidate_lifecycle_mismatch", message: "use the admitted package lifecycle for this asset" };
    const applied = await store.apply({ type: "reject", commandId: `withdraw:${versionId}`, issuedAt,
      proposalId: proposal.proposalId, reason: "user_requested_candidate_withdrawal" });
    return applied.ok ? { ok: true as const, versionId, state: "withdrawn" as const, changed: true }
      : { ok: false as const, code: applied.reason, message: applied.detail };
  });
  return "reason" in saved ? { ok: false as const, code: saved.reason, message: saved.detail } : saved;
}
