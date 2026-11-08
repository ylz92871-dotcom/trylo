import type { CentralLearningOperation, CentralRuntimeMaterial, CentralRuntimeWorkResult } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import type { ReadFailureReceipt } from "../../learning/central/runtime/read-failure.js";
import { canonicalReadAddress as address, readFailureReceipt } from "../../learning/central/runtime/read-failure.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CentralRuntimeSourceError } from "./runtime-source.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralBusinessSourceDirectory } from "./deliberation-business-sources.js";
import { readSessionContentAddress } from "../learning-content/sources/session-address.js";

type ReadOperation = Extract<CentralLearningOperation, { kind: "read" }>;

const reasons = ["content_material_missing", "content_feedback_material_missing", "content_material_ambiguous"] as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

type Catalog = { readonly sessionId: string; readonly turnId: string; readonly lastSourceHash: string;
  readonly entries: readonly { readonly address: string; readonly ref?: unknown; readonly originalSourceHash?: unknown }[] };

function catalogs(materials: readonly CentralRuntimeMaterial[]): readonly Catalog[] {
  return materials.flatMap(material => {
    const directory = centralBusinessSourceDirectory(material);
    if (directory === undefined) return [];
    const value = JSON.parse(material.text) as Catalog;
    return [{ ...value, entries: directory.lastShownRole === null ? [] : value.entries }];
  });
}

function turn(ref: string): { readonly sessionId: string; readonly turnId: string } | undefined {
  const runtime = /^central-runtime-page:\d+:(.+)$/.exec(ref), page = /^central-page:\d+:(.+)$/.exec(ref);
  try { if (runtime !== null || page !== null) return turn(runtime === null ? page![1]! : decodeURIComponent(runtime[1]!)); }
  catch { return undefined; }
  const value = readSessionContentAddress(ref);
  return value?.turnId === undefined ? undefined : { sessionId: value.sessionId, turnId: value.turnId };
}

/** Only authenticated, already delivered catalogs can establish a changed target version or a concrete navigation alternative. */
export function readOperationRefusal(input: { readonly scope: string; readonly operation: ReadOperation;
  readonly materials: readonly CentralRuntimeMaterial[]; readonly history: CentralRuntimeHistory; readonly error?: unknown }):
  { readonly result: CentralRuntimeWorkResult; readonly repeated?: string } | undefined {
  const known = catalogs(input.materials), previous = input.history.readFailures ?? [];
  const target = (ref: string) => {
    const normalized = address(ref), owner = turn(ref);
    const catalog = owner === undefined ? undefined : [...known].reverse().find(row => row.sessionId === owner.sessionId && row.turnId === owner.turnId);
    const entry = catalog?.entries.find(row => address(row.address) === normalized || row.ref === ref);
    return { address: normalized, version: entry !== undefined && hash(entry.originalSourceHash) ? entry.originalSourceHash : catalog?.lastSourceHash ?? "address" };
  };
  const targets = [...new Map(input.operation.refs.map(ref => {
    const value = target(ref);
    return [value.address, value] as const;
  })).values()]
    .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const targetHash = contentHashOf(targets);
  const prior = previous.find(row => row.receipt.scope === input.scope && row.receipt.targetHash === targetHash);

  if (input.error === undefined) return prior === undefined ? undefined : {
    repeated: prior.factRef, result: { outcome: "failed", resultRefs: [], publicResult: canonicalJson(prior.receipt),
      wait: { kind: "facts", reason: "central_read_failure_condition_unchanged", sourceRefs: [prior.factRef] } } };

  // Cross-owner ambiguity, identity/privacy/cancellation and unknown IO are deliberately not ordinary negatives.
  const error = input.error;
  if (!(error instanceof CentralRuntimeSourceError) && !(error instanceof CentralDeliberationError)) return undefined;

  if (error instanceof CentralDeliberationError && (error.delivery !== "not_sent" || error.reservationId !== undefined
    || error.providerFailure !== undefined || error.receiptFailure !== undefined)) return undefined;

  const reason = reasons.find(value => value === error.reason);
  if (reason === undefined) return undefined;

  const requested = new Set(targets.map(row => row.address));
  const alternatives = [...new Set(input.operation.refs.flatMap(ref => {
    const owner = turn(ref);
    if (owner === undefined) return [];
    const catalog = [...known].reverse().find(row => row.sessionId === owner.sessionId && row.turnId === owner.turnId);
    return (catalog?.entries ?? []).filter(row => {
      const entry = turn(row.address);
      return entry?.sessionId === owner.sessionId && entry.turnId === owner.turnId;
    }).map(row => row.address);
  }))].filter(ref => !requested.has(address(ref)) && !previous.some(row => row.receipt.scope === input.scope
    && row.receipt.targetCount === 1 && row.receipt.targetHash === contentHashOf([target(ref)]))).slice(0, 2);
  const receipt: ReadFailureReceipt = { schema: "central-read-failure/v1", scope: input.scope,
    targetHash, targetCount: targets.length, targets: targets.slice(0, 2), reason, alternatives };
  const publicResult = canonicalJson(receipt);
  if (readFailureReceipt(publicResult) === undefined) return undefined;

  return { result: { outcome: "failed", resultRefs: [], publicResult,
    ...(alternatives.length > 0 ? {} : { wait: { kind: "facts" as const, reason: "central_read_requires_new_original_path_or_version",
      sourceRefs: [input.operation.operationId] } }) } };
}
