import { createSkillCatalog } from "../../adapters/skills/catalog.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { sameSkillTaskFamily } from "../../learning/domains/skill/index.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";
import { decodeLearnedSkillContent, renderSelected } from "../../integration/skill-learning/catalog.js";
import type { LearnedSkillLoad } from "../../integration/skill-learning/contracts.js";
import { projectionScope } from "../../integration/content/scope.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { Transcript } from "../../protocol/transcript.js";

/** A durable successful exposure, never a claim about task quality. */
export type SkillJournalUse = LearnedSkillLoad & {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly resultSequence: number;
  readonly sourceRef: string;
};

/** Derive use only from a paired successful tool result and its actual event metadata. */
export function skillJournalUses(input: {
  readonly state: BoardState; readonly workspaceId: string; readonly contentRoot: string;
  readonly sessionId: string; readonly turnId: string; readonly transcript: Transcript;
  readonly events: readonly Envelope[]; readonly fromSequence?: number;
}): readonly SkillJournalUse[] {
  const found: SkillJournalUse[] = [];

  for (const call of input.transcript) {
    if (call.kind !== "tool_call" || call.name !== "skill" || call.sequence < (input.fromSequence ?? 0)) continue;

    const results = input.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === call.toolCallId && item.sequence > call.sequence);
    const result = results[0];
    if (results.length !== 1 || result?.kind !== "tool_result" || result.name !== "skill" || result.outcome !== "succeeded" || result.truncated) continue;

    const events = input.events.filter(event => event.sessionId === input.sessionId && event.turnId === input.turnId
      && event.kind === "tool_result" && event.payload.toolCallId === call.toolCallId);
    const event = events[0], value = event?.payload.value;
    if (events.length !== 1 || !event || event.payload.status !== "succeeded" || event.payload.output !== result.output
      || event.payload.truncated !== false || !record(value) || value.source !== "project" || value.fork !== false
      || value.skillRoot !== input.contentRoot.replaceAll("\\", "/")) continue;

    const requested = call.arguments.skill;
    if (typeof requested !== "string" || value.name !== requested.trim().replace(/^\//, "")
      || (call.arguments.args !== undefined && typeof call.arguments.args !== "string")) continue;

    for (const asset of input.state.assets) {
      const content = decodeLearnedSkillContent(asset.content);
      const proposal = input.state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
      if (asset.kind !== "skill" || asset.schemaVersion !== 1 || content?.workspaceId !== input.workspaceId
        || value.contentHash !== asset.contentHash || asset.contentHash !== contentHashOf(asset.content)
        || value.name !== `learned-${sha256Hex(asset.scope).slice(0, 16)}` || !proposal || proposal.assetKind !== "skill"
        || proposal.proposalId !== content.draft.id || proposal.scope !== asset.scope || projectionScope(content.draft.scope) !== asset.scope) continue;

      for (const variant of content.draft.variants) {
        const load = { versionId: asset.versionId, proposalId: proposal.proposalId, variantId: variant.id, contentHash: asset.contentHash };
        const expected = createSkillCatalog([{ name: value.name, description: "", source: "project", path: input.contentRoot,
          skillRoot: input.contentRoot, contentHash: asset.contentHash, body: renderSelected(content, variant, load),
          userInvocable: true, disableModelInvocation: false, forkExecution: false }]).load(value.name, call.arguments.args);
        if (expected.kind === "loaded" && result.output === expected.skill.content) found.push({ ...load,
          sessionId: input.sessionId, turnId: input.turnId, runId: `${input.sessionId}:${input.turnId}`,
          toolCallId: call.toolCallId, resultSequence: result.sequence, sourceRef: `journal:${input.sessionId}/${input.turnId}#${event.eventId}` });
      }
    }
  }

  return found.sort((a, b) => a.resultSequence - b.resultSequence);
}

/** Earlier failed checks cannot be attributed to a skill loaded later in the turn. */
export function skillUseBeforeCheck(uses: readonly SkillJournalUse[], state: BoardState, family: TaskFamily, sourceSequence: number): SkillJournalUse | undefined {
  return uses.filter(use => use.resultSequence <= sourceSequence && state.assets.some(asset => asset.versionId === use.versionId
    && decodeLearnedSkillContent(asset.content)?.draft.variants.some(variant => variant.id === use.variantId && sameSkillTaskFamily(variant.taskFamily, family))))
    .sort((a, b) => a.resultSequence - b.resultSequence).at(-1);
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
