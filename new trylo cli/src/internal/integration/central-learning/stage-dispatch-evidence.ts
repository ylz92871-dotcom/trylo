import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import { isCentralLearningFinishResult } from "../../learning/control/coordination-parse.js";
import { fields, identity, text } from "../../validation/json-shape.js";
import type { CentralFundedStage } from "./contracts.js";
import { isCentralFundedStage } from "./funded-stage.js";

export type CentralStageReceiptAddress = { readonly boardRoot: string; readonly scope: string; readonly domain: "workflow" | "collaboration" };

type Receipt = { readonly schemaVersion: 1; readonly type: "central_domain_dispatch_receipt";
  readonly scope: string; readonly domain: CentralStageReceiptAddress["domain"];
  readonly inputHash: string; readonly issueId: string; readonly grantId: string; readonly stageRef: string;
  readonly dispatch: FocusedLearningDispatch; readonly digest: string };

export type CentralStageReceiptUnknown = { readonly status: "unknown"; readonly reason: string };

type Unknown = CentralStageReceiptUnknown;

export type CentralStageReceiptRead = { readonly status: "ready"; readonly dispatch: FocusedLearningDispatch }
  | { readonly status: "absent" } | Unknown;

const MAX_BYTES = 131072;
const unknown = (reason: string): Unknown => ({ status: "unknown", reason });
const fileFor = (address: CentralStageReceiptAddress, input: CentralFundedStage) => path.join(address.boardRoot,
  "central-decisions", "stage-dispatch", `${contentHashOf([address.scope, input.grantId, input.stageRef])}.json`);

/** Keep only actual invocation facts needed by the original observer. In
 * particular, a wait preserves its status and never acquires later result refs. */
function projection(result: FocusedLearningDispatch): FocusedLearningDispatch {
  if (!result.ok) return { ok: false, workAttempted: true, reason: result.reason };
  return { ok: true, workAttempted: true, status: result.status,
    ...(result.issueId === undefined ? {} : { issueId: result.issueId }),
    ...(result.grantId === undefined ? {} : { grantId: result.grantId }),
    ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
    ...(result.result?.kind === "completed" ? { result: { kind: "completed", resultRefs: [...result.result.resultRefs] } }
      : result.status === "idle" && result.result?.kind === "yielded"
        ? { result: { kind: "yielded", reason: result.result.reason } } : {}) };
}

function isDispatch(value: unknown): value is FocusedLearningDispatch {
  if (fields(value, ["ok", "workAttempted", "reason"])) return value.ok === false && value.workAttempted === true && text(value.reason, 4096);

  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const optional = ["issueId", "grantId", "jobId", "result"].filter(key => Object.hasOwn(value, key));

  return fields(value, ["ok", "workAttempted", "status", ...optional]) && value.ok === true && value.workAttempted === true
    && ["idle", "busy", "completed", "waiting_dependency", "failed", "cancelled"].includes(String(value.status))
    && ["issueId", "grantId", "jobId"].every(key => !Object.hasOwn(value, key) || identity(value[key]))
    && (!Object.hasOwn(value, "result") || isCentralLearningFinishResult(value.result)
      && (value.result.kind === "completed" || value.status === "idle" && value.result.kind === "yielded"));
}

function isReceipt(value: unknown): value is Receipt {
  if (!fields(value, ["schemaVersion", "type", "scope", "domain", "inputHash", "issueId", "grantId", "stageRef", "dispatch", "digest"])
    || value.schemaVersion !== 1 || value.type !== "central_domain_dispatch_receipt"
    || value.domain !== "workflow" && value.domain !== "collaboration"
    || ![value.scope, value.inputHash, value.issueId, value.grantId, value.stageRef, value.digest].every(identity) || !isDispatch(value.dispatch)) return false;
  const { digest, ...payload } = value;
  return digest === contentHashOf(payload);
}

/** An immutable evidence file owns no balance, claim, dispatch right or outcome
 * label. Exact historical input and original returned refs are mandatory. */
export async function readCentralStageDispatchEvidence(address: CentralStageReceiptAddress, input: CentralFundedStage): Promise<CentralStageReceiptRead> {
  if (!isCentralFundedStage(input) || !identity(address.scope)) return unknown("central_stage_dispatch_receipt_address");

  let handle;

  try { handle = await open(fileFor(address, input), "r"); }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"
    ? { status: "absent" } : unknown("central_stage_dispatch_receipt_read_failed"); }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return unknown("central_stage_dispatch_receipt_capacity");

    const payload = await handle.readFile("utf8");
    if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) return unknown("central_stage_dispatch_receipt_capacity");

    let value: unknown;

    try { value = JSON.parse(payload); } catch { return unknown("central_stage_dispatch_receipt_invalid"); }

    if (!isReceipt(value) || value.scope !== address.scope || value.domain !== address.domain
      || value.inputHash !== contentHashOf(input) || value.issueId !== input.issueId || value.grantId !== input.grantId || value.stageRef !== input.stageRef) {
      return unknown("central_stage_dispatch_receipt_mismatch");
    }

    return { status: "ready", dispatch: value.dispatch };
  } catch { return unknown("central_stage_dispatch_receipt_read_failed"); }
  finally {
    try { await handle.close(); }
    catch { return unknown("central_stage_dispatch_receipt_read_failed"); }
  }
}

export async function retainCentralStageDispatchEvidence(address: CentralStageReceiptAddress, input: CentralFundedStage,
  actual: FocusedLearningDispatch): Promise<{ readonly status: "retained" } | Unknown> {
  if (actual.workAttempted !== true || !isCentralFundedStage(input) || !identity(address.scope)) return unknown("central_stage_dispatch_receipt_invalid");

  const payload = { schemaVersion: 1 as const, type: "central_domain_dispatch_receipt" as const, scope: address.scope, domain: address.domain,
    inputHash: contentHashOf(input), issueId: input.issueId, grantId: input.grantId, stageRef: input.stageRef, dispatch: projection(actual) };
  const receipt = { ...payload, digest: contentHashOf(payload) }, serialized = canonicalJson(receipt);
  if (!isReceipt(receipt) || Buffer.byteLength(serialized, "utf8") > MAX_BYTES) return unknown("central_stage_dispatch_receipt_capacity");

  const file = fileFor(address, input);

  try {
    await mkdir(path.dirname(file), { recursive: true });
    let handle;

    try { handle = await open(file, "wx"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return unknown("central_stage_dispatch_receipt_write_failed");
      const prior = await readCentralStageDispatchEvidence(address, input);
      return prior.status === "ready" && canonicalJson(prior.dispatch) === canonicalJson(receipt.dispatch)
        ? { status: "retained" } : unknown("central_stage_dispatch_receipt_conflict");
    }

    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    }
    finally { await handle.close(); }

    return { status: "retained" };
  } catch { return unknown("central_stage_dispatch_receipt_write_failed"); }
}
