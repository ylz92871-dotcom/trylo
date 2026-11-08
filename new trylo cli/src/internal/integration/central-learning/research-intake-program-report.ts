import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { LearningIssueReport } from "../../learning/control/coordination-contract.js";
import type { CentralResearchReception } from "./contracts.js";
import type { GroundedCentralResearch } from "./research-intake-common.js";
import { centralResearchEpisodeEvidence } from "./research-intake-episode.js";

interface Options { readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean; readonly now: () => number }

const PREFIX = "central-research-program-report:";
const PART = "episode_metadata_part:";
const PROGRAM = /^central-research-program:[a-f0-9]{64}$/;

/** Admission navigation on the original issue, not an execution/result receipt.
 * Copying the exact native source keeps every domain's source binding intact. */
export async function recordCentralResearchProgram(options: Options, request: GroundedCentralResearch,
  received: Extract<CentralResearchReception, { readonly status: "accepted" }>, signal: AbortSignal): Promise<CentralResearchReception> {
  const waiting = (reason: string): CentralResearchReception => ({ status: "waiting", reason,
    sourceRefs: [...new Set([received.issueId, ...received.sourceRefs])] });
  const active = () => options.enabled() && !signal.aborted;
  if (!active()) return waiting("central_research_intake_cancelled");

  const evidence = centralResearchEpisodeEvidence(request);
  if (evidence.length === 0) return received;

  const metadata = evidence.find(row => row.ref.startsWith("central-research-episode-metadata:"));
  const programRef = evidence.find(row => PROGRAM.test(row.ref))?.ref;
  if (metadata === undefined || programRef === undefined) return waiting("central_research_episode_metadata_invalid");

  const chunks: string[] = [];

  for (let offset = 0; offset < metadata.summary.length; offset += 1400) chunks.push(`${PART}${metadata.summary.slice(offset, offset + 1400)}`);

  if (chunks.length > 7) return waiting("central_research_program_report_capacity");

  const outcome = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return waiting(loaded.reason);

    const issue = loaded.state.learningIssues?.find(row => row.issueId === received.issueId && row.scope === options.scope);
    const owner = issue === undefined ? undefined : learningIssueOwner(issue);
    if (issue === undefined || (owner === "method" ? "prompt" : owner) !== request.domain) return waiting("central_research_program_owner_mismatch");

    if (issue.decision.kind === "ordinary_execution" || issue.decision.kind === "resolved") return waiting("central_research_native_purpose_closed");

    const original = [...issue.reports].reverse().find(row => !row.reportId.startsWith(PREFIX));
    if (original === undefined || !original.evidenceRefs.includes(request.intent.intentId)
      || "kind" in original.source && (original.source.requestRef !== request.requestRef || original.source.intentRef !== request.intent.intentId)) {
      return waiting("central_research_program_native_binding_missing");
    }

    // A retry of an already admitted program never rewrites its original
    // metadata with today's selection label, source catalog or operation ID.
    const reportId = `${PREFIX}${contentHashOf([options.scope, issue.issueId, request.requestRef, programRef])}`;
    const existing = issue.reports.find(row => row.reportId === reportId);
    if (existing !== undefined) {
      return canonicalJson(existing.source) === canonicalJson(original.source) && existing.evidenceRefs.includes(programRef)
        ? received : waiting("central_research_program_report_conflict");
    }

    const recordRefs = original.evidenceRefs.filter(ref => ref.startsWith("collaboration-central-research:")
      || ref.startsWith("skill-research-source:") || ref.startsWith("method-research-record:"));
    const refs = [...new Set([request.intent.intentId, request.requestRef, ...recordRefs, ...evidence.map(row => row.ref)])];
    if (refs.length > 32 || refs.some(ref => ref.length > 512)) return waiting("central_research_program_report_capacity");

    const report: LearningIssueReport = { reportId, source: original.source,
      facts: ["central_research_program_reception_not_execution", ...chunks], evidenceRefs: refs };
    const action = { kind: "report" as const, scope: options.scope, issueId: issue.issueId, problemKey: issue.problemKey, report };
    const saved = await store.apply({ type: "coordinate_learning", commandId: reportId,
      issuedAt: new Date(options.now()).toISOString(), action });

    return saved.ok ? received : waiting(saved.reason);
  }, { commandGuard: active });

  return "status" in outcome ? outcome : waiting(outcome.reason);
}
