import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BoardStore } from "../../../../control/store-port.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { centralSkillResearchFromBoard } from "../control/central-research-board.js";
import { readSkillReviewOutcome } from "../control/review-outcome.js";

type FileEvidence = { readonly path: string; readonly sha256: string };
const verified = Symbol("verified-central-skill-creation");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => { throw new Error("hermes_central_creation_evidence_invalid"); };

export type CentralSkillCreationRepairInput = {
  readonly scope: string;
  readonly managedWork: FileEvidence;
  readonly nativeCreate: FileEvidence;
  readonly nativeApply: FileEvidence;
  readonly expectedCurrentInstructionHash: string;
  readonly expectedCurrentBodySha256: string;
};

/** Constructible only by the original Board/source and native receipt reader.
 * This maintenance authority is never an opportunity field or MCP argument. */
export type VerifiedCentralSkillCreation = {
  readonly [verified]: true;
  readonly ref: string;
  readonly scope: string;
  readonly audit: Readonly<Record<string, unknown>>;
  readonly native: Readonly<Record<string, unknown>>;
};

async function evidence(file: FileEvidence): Promise<unknown> {
  const bytes = await readFile(file.path);
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || createHash("sha256").update(bytes).digest("hex") !== file.sha256) return invalid();
  return JSON.parse(bytes.toString("utf8"));
}

/** Proves this exact historical creation, not all local or assistant-owned skills. */
export async function verifyCentralSkillCreation(board: Pick<BoardStore, "load">,
  input: CentralSkillCreationRepairInput): Promise<VerifiedCentralSkillCreation> {
  const work = await evidence(input.managedWork), create = await evidence(input.nativeCreate), apply = await evidence(input.nativeApply);
  if (!object(work) || !object(work.frame) || typeof work.frame.inputJson !== "string" || !object(create)
    || !object(create.native) || !object(create.entry) || !object(apply) || !object(apply.input) || !object(apply.cliReply)
    || !object(apply.cliReply.body) || !object(apply.cliReply.body.result)) return invalid();
  const frame: unknown = JSON.parse(work.frame.inputJson), pending = create.native, committed = apply.cliReply.body.result;
  if (!object(frame) || typeof frame.issueId !== "string" || typeof frame.grantId !== "string" || !object(pending.payload)
    || pending.origin !== "assistant_tool" || pending.payload.action !== "create" || typeof pending.payload.name !== "string"
    || typeof pending.payload.content !== "string" || typeof pending.payloadHash !== "string" || typeof create.entry.pendingId !== "string"
    || pending.id !== create.entry.pendingId || create.entry.action !== "create" || create.entry.name !== pending.payload.name
    || apply.exitCode !== 0 || apply.cliReply.body.ok !== true || committed.success !== true || committed.committed !== true
    || committed.pendingId !== create.entry.pendingId || committed.action !== "create" || committed.skillName !== pending.payload.name
    || committed.payloadHash !== pending.payloadHash || apply.input.expectedHash !== pending.payloadHash
    || committed.instructionHash !== contentHashOf(pending.payload.content)
    || !/^[a-f0-9]{64}$/.test(input.expectedCurrentInstructionHash) || !/^[a-f0-9]{64}$/.test(input.expectedCurrentBodySha256)) return invalid();

  const loaded = await board.load();
  if (!loaded.ok) throw new Error(loaded.reason);
  const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === frame.grantId);
  const job = loaded.state.jobs.find(item => item.jobId === grant?.jobId);
  const issue = loaded.state.learningIssues?.find(item => item.issueId === frame.issueId);
  const report = issue?.reports.find(item => "kind" in item.source && item.source.domain === "skill");
  if (grant?.domain !== "skill" || grant.scope !== input.scope || grant.issueId !== frame.issueId || grant.status !== "closed"
    || grant.closedReason !== "completed" || grant.reservations.some(item => item.usage?.kind !== "reported")
    || job?.state !== "succeeded" || job.coordination?.grantId !== grant.grantId || job.coordination.issueId !== frame.issueId
    || !job.coordination.resultRefs?.includes(`hermes-pending:skills:${create.entry.pendingId}`)
    || issue?.scope !== input.scope || report === undefined || !("kind" in report.source)) return invalid();
  const research = centralSkillResearchFromBoard(loaded.state, input.scope, report.source.requestRef);
  if (research.status !== "found" || research.request.intentRef !== report.source.intentRef
    || !report.evidenceRefs.includes(research.recordRef)) return invalid();
  const claimId = grant.reservations.at(-1)?.claimId;
  if (claimId === undefined) return invalid();
  const outcome = readSkillReviewOutcome(loaded.state, { schemaVersion: 1, scope: input.scope, issueId: issue.issueId,
    jobId: job.jobId, grantId: grant.grantId, claimId, attempt: job.attempt, focusRevision: grant.focusRevision,
    reservationIds: grant.reservations.map(item => item.reservationId) });
  if (!outcome.ok || typeof outcome.outcomeRef !== "string" || outcome.outcome?.result.kind !== "completed"
    || !outcome.outcome.result.resultRefs.includes(`hermes-pending:skills:${create.entry.pendingId}`)) return invalid();

  const audit = { schemaVersion: 1, scope: input.scope, name: pending.payload.name, pendingId: create.entry.pendingId,
    jobId: job.jobId, grantId: grant.grantId, issueId: issue.issueId, requestRef: research.request.requestRef,
    researchRecordRef: research.recordRef, outcomeRef: outcome.outcomeRef, originalNativeOrigin: pending.origin,
    originalPayloadHash: pending.payloadHash, originalInstructionHash: committed.instructionHash,
    evidence: { managedWork: input.managedWork, nativeCreate: input.nativeCreate, nativeApply: input.nativeApply },
    expectedCurrentInstructionHash: input.expectedCurrentInstructionHash, expectedCurrentBodySha256: input.expectedCurrentBodySha256 };
  const ref = `hermes-central-origin-repair:${contentHashOf(audit)}`;
  return { [verified]: true, ref, scope: input.scope, audit, native: { repairRef: ref, audit,
    originalPending: pending, approvedCreation: committed,
    expectedCurrentInstructionHash: input.expectedCurrentInstructionHash, expectedCurrentBodySha256: input.expectedCurrentBodySha256 } };
}

/** One canonical audit owner, one original native metadata writer. No body or
 * historical pending origin is rewritten. A partial native effect stays visible. */
export async function repairCentralSkillOrigin(options: {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly proof: VerifiedCentralSkillCreation;
  readonly now: () => string;
  readonly native: (proof: VerifiedCentralSkillCreation, mode: "inspect" | "repair", previous?: unknown) => Promise<unknown>;
}) {
  const { proof } = options;
  if (proof[verified] !== true) return invalid();
  const loaded = await options.board.load();
  if (!loaded.ok) throw new Error(loaded.reason);
  const prior = (phase: string): unknown => {
    const fact = loaded.state.rewardV2Facts?.find(item => item.id === `${proof.ref}:${phase}`);
    if (fact === undefined) return undefined;
    let body: unknown;
    try { body = JSON.parse(fact.payloadJson); }
    catch { throw new Error("hermes_origin_repair_audit_corrupt"); }
    if (!object(body) || fact.algorithmVersion !== "hermes-central-origin-repair/v1" || fact.kind !== "projection" || fact.scope !== proof.scope
      || body.repairRef !== proof.ref || body.phase !== phase || canonicalJson(body.proof) !== canonicalJson(proof.audit)) {
      throw new Error("hermes_origin_repair_audit_corrupt");
    }
    return body.receipt;
  };
  const observed = prior("observed");
  if (observed !== undefined) return { ok: object(observed) && observed.success === true,
    repairRef: proof.ref, nativeReceipt: observed, alreadyRecorded: true };
  const record = async (phase: string, receipt: unknown) => {
    const loaded = await options.board.load();
    if (!loaded.ok) throw new Error(loaded.reason);
    const fact = { id: `${proof.ref}:${phase}`, scope: proof.scope, algorithmVersion: "hermes-central-origin-repair/v1",
      kind: "projection" as const, payloadJson: canonicalJson({ phase, repairRef: proof.ref, proof: proof.audit, receipt }) };
    const existing = loaded.state.rewardV2Facts?.find(item => item.id === fact.id);
    if (existing !== undefined) {
      if (existing.payloadJson !== fact.payloadJson) throw new Error("hermes_origin_repair_audit_conflict");
      return;
    }
    const written = await options.board.apply({ type: "record_reward_v2_fact", commandId: `record:${fact.id}`,
      issuedAt: options.now(), expectedSequence: loaded.state.sequence, fact });
    if (!written.ok) throw new Error(written.reason);
  };
  const inspected = prior("prepared") ?? await options.native(proof, "inspect");
  if (!object(inspected) || inspected.success !== true) return { ok: false as const, nativeReceipt: inspected };
  await record("prepared", inspected);
  const receipt = await options.native(proof, "repair", inspected);
  // Record the exact native reply even when it reports an unknown/partial effect.
  await record("observed", receipt);
  return { ok: object(receipt) && receipt.success === true, repairRef: proof.ref, nativeReceipt: receipt };
}
