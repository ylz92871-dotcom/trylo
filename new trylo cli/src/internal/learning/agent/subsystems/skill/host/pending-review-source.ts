import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isJsonData, recordOf } from "../../../../../tooling/contract/json-value.js";
import { identity } from "../../../../../validation/json-shape.js";

export type SkillPendingReviewOptions = {
  readonly board: Pick<BoardStore, "load">;
  readonly scope: string;
  readonly native: (method: "pendingList" | "pendingDetail", params: JsonObject, signal: AbortSignal) => Promise<unknown>;
};

export class SkillPendingReviewError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SkillPendingReviewError";
  }
}

const fail = (reason: string): never => { throw new SkillPendingReviewError(reason); };
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is JsonObject => recordOf(value) && isJsonData(value, 24);

export type SkillPendingReviewEntry = { readonly pendingId: string; readonly expectedHash: string; readonly name: string;
  readonly action: string; readonly summary: string; readonly sourceRefs: readonly string[] };

/** Native pending content remains the one source. Board receipts provide exact
 * workspace attribution; names or list set-differences never assign ownership. */
export function createSkillPendingReviewSource(options: SkillPendingReviewOptions) {
  const check = (signal: AbortSignal) => { if (signal.aborted) fail("learning_aborted"); };
  const list = async (signal: AbortSignal) => {
    check(signal);
    const loaded = await options.board.load();
    if (!loaded.ok) return fail("skill_pending_board_unavailable");

    const body = await options.native("pendingList", {}, signal);
    check(signal);

    if (!object(body) || body.ok !== true || !Array.isArray(body.pending) || !body.pending.every(object)) return fail("skill_pending_list_invalid");

    const entries: SkillPendingReviewEntry[] = [];

    for (const pending of body.pending) {
      if (pending.subsystem !== "skills") continue;

      if (!identity(pending.id) || !hash(pending.payloadHash) || typeof pending.target !== "string"
        || typeof pending.action !== "string") return fail("skill_pending_list_invalid");

      const pendingRef = `hermes-pending:skills:${pending.id}`;
      const bindings = loaded.state.jobs.flatMap(job => {
        if (job.domain !== "skill" || job.scope !== options.scope || !job.coordination?.resultRefs?.includes(pendingRef)) return [];
        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === job.coordination?.grantId
          && item.domain === "skill" && item.scope === options.scope && item.jobId === job.jobId && item.issueId === job.coordination.issueId);
        const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId && item.scope === options.scope
          && item.jobId === job.jobId && item.grantId === grant?.grantId && learningIssueOwner(item) === "skill");
        return grant === undefined || issue === undefined ? [] : [{ job, grant, issue }];
      });
      if (bindings.length === 0) continue;

      if (bindings.length !== 1 || entries.some(item => item.pendingId === pending.id)) return fail("skill_pending_source_ambiguous");

      const binding = bindings[0]!;

      entries.push({ pendingId: pending.id, expectedHash: pending.payloadHash, name: pending.target, action: pending.action,
        summary: typeof pending.summary === "string" ? pending.summary : "",
        sourceRefs: [...new Set([pendingRef, binding.issue.issueId, binding.grant.grantId, binding.job.jobId,
          ...binding.issue.reports.flatMap(report => report.evidenceRefs)])] });
    }

    return { entries, snapshotRef: `skill-pending-catalog:${contentHashOf(entries)}` };
  };
  const detail = async (pendingId: string, signal: AbortSignal) => {
    if (!identity(pendingId)) fail("skill_pending_id_invalid");

    const catalog = await list(signal), entry = catalog.entries.find(item => item.pendingId === pendingId);
    if (entry === undefined) return fail("skill_pending_not_in_workspace");

    const body = await options.native("pendingDetail", { subsystem: "skills", id: pendingId }, signal);
    check(signal);

    if (!object(body) || body.ok !== true || !object(body.detail)) return fail("skill_pending_detail_invalid");

    const native = body.detail;
    if (native.success !== true || native.id !== pendingId || native.subsystem !== "skills" || !hash(native.payloadHash)
      || native.payloadHash !== entry.expectedHash || native.target !== entry.name || native.action !== entry.action) return fail("skill_pending_detail_changed");

    return { entry, native };
  };

  return { list, detail };
}
