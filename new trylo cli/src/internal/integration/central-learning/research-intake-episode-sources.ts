import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import type { TaskSourcePage } from "../learning-content/task-source-pages.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { CentralResearchIntakeError } from "./research-intake-common.js";
import { readRequiredUserCatalogAddress } from "../learning-content/sources/session-required-index.js";
import { readSessionPublicTurnAddress } from "../learning-content/sources/session-public-turn.js";
import type { BoardState } from "../../learning/control/state.js";
import { PUBLIC_SOURCE_BODY_PREFIX, readRuntimePublicSourceFrame } from "./runtime-source-frames.js";
import { lookupCentralRuntimeRecord } from "../../learning/central/runtime/records.js";

export interface CentralResearchSourceReadScope {
  readonly acceptedScopes?: readonly string[];
  readonly board?: BoardState;
}

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (ref: string): never => { throw new CentralResearchIntakeError("central_research_source_page_invalid", [ref]); };

export function centralResearchSourcePage(material: CentralRuntimeMaterial, scope: string,
  selection: CentralResearchSourceReadScope = {}): TaskSourcePage | undefined {
  // A user's JSON body is never recursively promoted to host source metadata.
  if (!material.ref.startsWith("central-source-page:")) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); }
  catch { return fail(material.ref); }

  const optional = typeof body === "object" && body !== null
    ? ["originalSource", "nextRef"].filter(key => Object.hasOwn(body, key)) : [];
  if (!fields(body, ["role", "ref", "originalRef", "origin", "originalScope", "start", "end", "totalChars", "text", "sourceHash", "coordinate", "owner", "complete", ...optional])
    || body.role !== "actual_source_fragment_not_full_source"
    || !text(body.ref, 512) || !text(body.originalRef, 512) || !text(body.originalScope, 512)
    || !["session", "board", "feedback", "domain_feedback"].includes(String(body.owner))
    || !["user_statement", "execution_result", "checker_result", "model_proposal"].includes(String(body.origin))
    || !fields(body.coordinate, ["runId", "sequence"]) || !text(body.coordinate.runId, 512) || !sequence(body.coordinate.sequence)
    || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars) || body.end <= body.start
    || body.end > body.totalChars || typeof body.text !== "string" || body.text.length !== body.end - body.start
    || !digest(body.sourceHash)) return fail(material.ref);

  let originalSource: TaskSourcePage["originalSource"];

  if (Object.hasOwn(body, "originalSource")) {
    if (!fields(body.originalSource, ["ref", "runId", "sequence", "sourceHash"]) || !text(body.originalSource.ref, 512)
      || !text(body.originalSource.runId, 512) || !sequence(body.originalSource.sequence) || !digest(body.originalSource.sourceHash)) return fail(material.ref);
    originalSource = { ref: body.originalSource.ref, runId: body.originalSource.runId,
      sequence: body.originalSource.sequence, sourceHash: body.originalSource.sourceHash };
  }

  const page: TaskSourcePage = { ref: body.ref, originalRef: body.originalRef, originalScope: body.originalScope,
    origin: body.origin === "user_statement" ? "user_statement" : body.origin === "execution_result" ? "execution_result"
      : body.origin === "checker_result" ? "checker_result" : "model_proposal",
    owner: body.owner === "session" ? "session" : body.owner === "board" ? "board" : body.owner === "feedback" ? "feedback" : "domain_feedback",
    coordinate: { runId: body.coordinate.runId, sequence: body.coordinate.sequence }, sourceHash: body.sourceHash,
    start: body.start, end: body.end, totalChars: body.totalChars, text: body.text,
    ...(originalSource === undefined ? {} : { originalSource }) };
  let rebuilt: CentralRuntimeMaterial;

  try { rebuilt = centralMaterialFromPage(page); }
  catch { return fail(material.ref); }

  if (canonicalJson(rebuilt) !== canonicalJson(material)) return fail(material.ref);

  if (!new Set([scope, ...selection.acceptedScopes ?? []]).has(page.originalScope)) {
    const known = selection.board === undefined ? undefined : lookupCentralRuntimeRecord(selection.board.rewardV2Facts ?? [], scope,
      selection.board.sequence, { kind: "material", ref: material.ref });
    if (known?.status === "found" && canonicalJson(known.value) === canonicalJson(material)) return page;

    const archivedRef = [page.ref, page.originalRef].find(value => value.startsWith(PUBLIC_SOURCE_BODY_PREFIX));
    const archived = selection.board === undefined || archivedRef === undefined ? undefined
      : readRuntimePublicSourceFrame(selection.board, { scope, ref: archivedRef });
    if (page.owner !== "domain_feedback" || archived === undefined
      || (archived.origin.originalIssueScope ?? scope) !== page.originalScope
      || page.sourceHash !== archived.publicTextHash || page.totalChars !== archived.text.length
      || page.text !== archived.text.slice(page.start, page.end)) return fail(material.ref);
  }

  return page;
}

/** This is a deduplication signature of actual read source units/revisions, never
 * a sample count or truth verdict. Paging/ref and derived-view hashes add no unit.
 */
export function centralResearchReadSourceSignatures(materials: readonly CentralRuntimeMaterial[], scope: string,
  selection: CentralResearchSourceReadScope = {}): readonly string[] {
  const signatures = new Set<string>();

  for (const material of materials) {
    const page = centralResearchSourcePage(material, scope, selection);
    if (page === undefined || page.origin === "model_proposal" || derivedNavigation(page)) continue;
    const original = page.originalSource;
    signatures.add(contentHashOf({ owner: page.owner, origin: page.origin, scope: page.originalScope,
      originalRef: original?.ref ?? page.originalRef, sourceHash: original?.sourceHash ?? page.sourceHash,
      coordinate: original === undefined ? page.coordinate : { runId: original.runId, sequence: original.sequence } }));
  }

  return [...signatures].sort();
}

function derivedNavigation(page: TaskSourcePage): boolean {
  // Domain feedback is an owner projection over native rows. Its full-frame
  // hash is never a raw unit; the native evidence reader admits read rows.
  if (page.owner === "domain_feedback") return true;

  const original = page.originalSource;
  const ref = original?.ref ?? page.originalRef, coordinate = original ?? page.coordinate;
  if (coordinate.sequence !== 0 || coordinate.runId !== ref) return false;

  if (page.owner === "session" && (readRequiredUserCatalogAddress(ref) !== undefined || readSessionPublicTurnAddress(ref) !== undefined)) return true;

  return /^(?:domain-feedback-(?:basis|absence|manifest)|content-recall|central-runtime-(?:catalog|manifest)|session-issue-source-(?:catalog|manifest)|session-required-user-index|session-content-association|content-(?:user-source-basis|feedback-coverage|feedback-heads)):[a-f0-9]{64}$/.test(ref);
}
