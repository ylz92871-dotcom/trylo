import { decodeLog } from "../../../../../adapters/learning-store/codec.js";
import { readBoardLog } from "../../../../../adapters/learning-store/board-replay.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CentralFundedStage } from "../../../../../integration/central-learning/contracts.js";
import { readFrozenStage } from "../../../../../integration/central-learning/stage-evidence.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { methodResearchGrantId, methodResearchRecord, readMethodResearch, type MethodResearchRejected } from "./central-research-records.js";

/** Compatibility for the former paid-output rejection path, which settled and
 * yielded but omitted a checkpoint. Only an exact native finish plus its frozen
 * assignment can recover that missing negative record. Unknown calls stay put. */
export async function recoverCentralMethodResearchRejection(options: { readonly boardRoot: string; readonly scope: string;
  readonly input: CentralFundedStage; readonly model: string; readonly now: () => number; readonly enabled: () => boolean }, signal: AbortSignal) {
  const { input } = options;
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) throw new Error(loaded.reason);

  const issue = loaded.state.learningIssues?.find(row => row.scope === options.scope && row.issueId === input.issueId);
  const source = issue?.reports[0]?.source;
  if (source === undefined || !("kind" in source) || source.kind !== "research_request" || source.domain !== "prompt") return undefined;

  const history = readMethodResearch(loaded.state, options.scope, source.requestRef);
  const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === input.grantId);
  if (history === undefined || grant?.grantId !== methodResearchGrantId(source.requestRef) || grant.scope !== options.scope
    || grant.issueId !== input.issueId || grant.domain !== "prompt" || grant.claim !== undefined || grant.status !== "open") return undefined;

  const missing = grant.reservations.filter(row => !history.checkpoints.some(checkpoint => checkpoint.step.reservationId === row.reservationId));
  if (missing.length !== 1) return undefined;

  const reservation = missing[0]!;
  if (reservation.state !== "settled" || reservation.usage?.kind !== "reported"
    || reservation.reservationId !== `method-research-call:${contentHashOf([input.stageRef, history.headRef, options.model])}`) return undefined;

  const frozen = await readFrozenStage({ boardRoot: options.boardRoot, scope: options.scope, grantId: input.grantId, stageRef: input.stageRef });
  if (frozen.status !== "ready" || canonicalJson(frozen.value.input) !== canonicalJson(input)) return undefined;

  const log = decodeLog((await readBoardLog(options.boardRoot)).toString("utf8"));
  if (!log.ok) throw new Error(log.reason);

  const finish = [...log.records].reverse().find(row => {
    if (row.sequence > loaded.state.sequence || row.command.type !== "coordinate_learning") return false;

    const action = row.command.action;

    return action.kind === "finish" && action.jobId === grant.jobId && action.claimId === reservation.claimId
      && action.expectedIssueRevision === input.expectedIssueRevision && action.result.kind === "yielded"
      && action.result.reason === "method_research_output_invalid" && row.events.some(event =>
        event.type === "learning_coordination_changed" && event.grant?.grantId === grant.grantId
        && event.grant.reservations.some(value => canonicalJson(value) === canonicalJson(reservation)));
  });
  if (finish === undefined) return undefined;

  const value: MethodResearchRejected = { type: "method_research_rejected", schemaVersion: 1,
    requestRef: source.requestRef, previousRef: history.headRef, reservationId: reservation.reservationId,
    contextRef: input.sourceContext?.ref ?? history.requestId, stageInputHash: contentHashOf(input),
    reason: "method_research_output_invalid", evidence: { kind: "native_finish", commandId: finish.commandId } };
  const fact = methodResearchRecord(options.scope, value);
  const result = await withBoardWriter(options.boardRoot, async store => {
    const current = await store.load();
    if (!current.ok) throw new Error(current.reason);
    const latest = readMethodResearch(current.state, options.scope, source.requestRef);
    const owner = current.state.centralLearningGrants?.find(row => row.grantId === input.grantId);
    if (latest?.headRef !== history.headRef || canonicalJson(owner) !== canonicalJson(grant)) throw new Error("method_research_recovery_owner_changed");
    readMethodResearch({ ...current.state, rewardV2Facts: [...(current.state.rewardV2Facts ?? []), { ...fact, sequence: current.state.sequence + 1 }] }, options.scope, source.requestRef);
    return store.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: new Date(options.now()).toISOString(), expectedSequence: current.state.sequence, fact });
  }, { commandGuard: () => options.enabled() && !signal.aborted });
  if (!result.ok) throw new Error(result.reason);

  return fact.id;
}
