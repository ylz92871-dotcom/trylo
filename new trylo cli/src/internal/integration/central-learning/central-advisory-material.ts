import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_ADVISORY_CATALOG_PREFIX, CENTRAL_ADVISORY_CATALOG_ROLE, CENTRAL_ADVISORY_CONTEXT_ENTRIES,
  CENTRAL_ADVISORY_RESULT_MATERIAL_PREFIX, CENTRAL_ADVISORY_RESULT_ROLE, readCentralAdvisoryCatalogMaterial,
  readCentralAdvisoryResultMaterial, type CentralAdvisoryCatalogBody, type CentralAdvisoryResultBody } from "../../learning/central/runtime/advisory-material.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { readAppliedCentralAdvisoryDecisions, type AppliedCentralAdvisoryDecision } from "./central-advisory-applied-decisions.js";
import { readCentralAdvisoryRecords, resolveCentralAdvisoryPublications } from "./central-advisory-records.js";
import { readCentralAdvisoryResult } from "./central-advisory-results.js";
import type { CentralAdvisoryPublicationView, CentralAdvisoryRecord } from "./central-advisory-contracts.js";

export const CENTRAL_ADVISORY_CONTEXT_CHARS = 32768;
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const fail = (): never => { throw new Error("central_advisory_material_capacity"); };

function material(prefix: string, value: CentralAdvisoryCatalogBody | CentralAdvisoryResultBody, sourceRefs: readonly string[]): CentralRuntimeMaterial {
  const text = canonicalJson(value), row = { ref: `${prefix}${contentHashOf(text)}`, kind: "source" as const, text, sourceRefs };
  if (!isCentralRuntimeMaterial(row)) return fail();
  return row;
}

function catalog(board: BoardState, scope: string): CentralRuntimeMaterial | undefined {
  const publications = resolveCentralAdvisoryPublications({ facts: board.rewardV2Facts ?? [], scope, boardSequence: board.sequence })
    .filter(row => row.status === "current").sort((left, right) => right.sequence - left.sequence || left.version.localeCompare(right.version))
    .slice(0, CENTRAL_ADVISORY_CONTEXT_ENTRIES);
  if (publications.length === 0) return undefined;

  const value: CentralAdvisoryCatalogBody = { schemaVersion: 1, role: CENTRAL_ADVISORY_CATALOG_ROLE, scope, boardSequence: board.sequence,
    entries: publications.map(row => ({ version: row.version, readRef: row.version, id: row.id, intentId: row.intentId,
      knowledgeHash: row.knowledgeHash, status: "current" as const })) };

  return material(CENTRAL_ADVISORY_CATALOG_PREFIX, value, publications.map(row => row.version));
}

function resultMaterial(board: BoardState, decision: AppliedCentralAdvisoryDecision,
  records: readonly CentralAdvisoryRecord[]): CentralRuntimeMaterial | undefined {
  const result = readCentralAdvisoryResult(board.rewardV2Facts ?? [], decision, board.sequence);
  if (result === undefined) return undefined;

  const value: CentralAdvisoryResultBody = { schemaVersion: 1, role: CENTRAL_ADVISORY_RESULT_ROLE, scope: decision.request.scope,
    resultRef: result.resultRef, decisionRef: decision.decisionRef, deliveryRef: decision.deliveryRef, appliedStateRef: decision.appliedStateRef,
    entries: result.results.map(entry => {
      const action = decision.output.knowledgeHandoffs?.[entry.index];
      const target = action?.kind === "withdraw" ? records.find(row => row.ref === action.publicationRef) : undefined;
      const intentId = action?.kind === "publish" ? action.intentId : target?.value.kind === "publish" ? target.value.intentId : null;
      return { ...entry, intentId };
    }) };
  const row = material(CENTRAL_ADVISORY_RESULT_MATERIAL_PREFIX, value, [result.resultRef]);
  if (readCentralAdvisoryResultMaterial(row) === undefined) throw new Error("central_advisory_result_material_invalid");
  return row;
}

/** Current navigation and exact native handoff outcomes only. Neither creates
 * an opportunity, wake, evidence unit, publication, or another thought. */
export function centralAdvisoryContextMaterials(board: BoardState, scope: string): readonly CentralRuntimeMaterial[] {
  const records = readCentralAdvisoryRecords(board.rewardV2Facts ?? [], scope, board.sequence), selected: CentralRuntimeMaterial[] = [];
  const directory = catalog(board, scope);
  if (directory !== undefined) selected.push(directory);

  let chars = selected.reduce((sum, row) => sum + row.text.length, 0), count = 0;
  const decisions = [...readAppliedCentralAdvisoryDecisions(board.rewardV2Facts ?? [], scope, board.sequence)].reverse();

  for (const decision of decisions) {
    const row = resultMaterial(board, decision, records);
    if (row === undefined) continue;
    if (count >= CENTRAL_ADVISORY_CONTEXT_ENTRIES || chars + row.text.length > CENTRAL_ADVISORY_CONTEXT_CHARS) break;
    selected.push(row);
    chars += row.text.length;
    count += 1;
  }

  return selected;
}

/** Resolve an immutable result summary independently of the bounded current
 * recall window. The original result reader authenticates every action/status. */
export function readCentralAdvisoryResultContextMaterial(board: BoardState, scope: string, ref: string): CentralRuntimeMaterial | undefined {
  const records = readCentralAdvisoryRecords(board.rewardV2Facts ?? [], scope, board.sequence);
  for (const decision of readAppliedCentralAdvisoryDecisions(board.rewardV2Facts ?? [], scope, board.sequence)) {
    const row = resultMaterial(board, decision, records);
    if (row !== undefined && (row.ref === ref || readCentralAdvisoryResultMaterial(row)?.resultRef === ref)) return row;
  }
  return undefined;
}

/** Structural role alone never authenticates a control. Rebuild from the
 * actual original prefix before excluding this wrapper from access ancestry. */
export function isOriginalCentralAdvisoryContextMaterial(board: BoardState, scope: string, row: CentralRuntimeMaterial): boolean {
  const directory = readCentralAdvisoryCatalogMaterial(row);
  if (directory !== undefined) {
    if (directory.scope !== scope || directory.boardSequence > board.sequence) return false;
    const prefix = { ...board, sequence: directory.boardSequence,
      rewardV2Facts: (board.rewardV2Facts ?? []).filter(fact => fact.sequence <= directory.boardSequence) };
    const expected = catalog(prefix, scope);
    return expected !== undefined && same(expected, row);
  }

  const result = readCentralAdvisoryResultMaterial(row);

  return result !== undefined && result.scope === scope && same(readCentralAdvisoryResultContextMaterial(board, scope, row.ref) ?? null, row);
}

export function centralAdvisoryPublicationMaterial(scope: string, publication: CentralAdvisoryPublicationView): CentralRuntimeMaterial {
  const text = canonicalJson({ schemaVersion: 1, role: "central_published_advisory_not_independent_validation", scope, publication });
  const row: CentralRuntimeMaterial = { ref: `central-advisory-publication-view:${contentHashOf({ scope, text })}`, kind: "knowledge", text,
    // One original authority edge; the ancestry reader re-derives its complete
    // access closure instead of truncating it to the model material's ref cap.
    sourceRefs: [publication.version] };
  if (!isCentralRuntimeMaterial(row)) return fail();
  return row;
}
