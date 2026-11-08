import type { CentralRuntimeMaterial } from "./contracts.js";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { coordinationScopeValid } from "../../control/coordination-scope.js";
import { fields, identity, sequence, text } from "../../../validation/json-shape.js";

export const CENTRAL_JUDGMENT_VIEW_PREFIX = "central-judgment-view-v1:";
export const CENTRAL_JUDGMENT_VIEW_ROLE = "central_public_judgment_context_v1";
const INTERPRETATION = "Original central public judgment and decision progress may inform hypotheses, reasoning and continuing the original purpose. It is not independent business evidence, learned knowledge, use or benefit. This bounded readable view does not replace the full original material; original receipts, outcomes and charges remain authoritative.";
const MAX_REFS = 256, MAX_REF_CHARS = 512, MAX_MATERIAL_CHARS = 32768;
const VIEW_TEXT_CHARS = 512, VIEW_REFS = 8;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const reference = (value: unknown): value is string => text(value, MAX_REF_CHARS) && !/[\u0000-\u001f]/.test(value);
const prose = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_MATERIAL_CHARS
  && [...value].every(character => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });

function referenceList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_REFS && Reflect.ownKeys(value).length === value.length + 1
    && value.every(reference);
}

const references = (value: unknown): value is readonly string[] => referenceList(value) && new Set(value).size === value.length;
const unique = (refs: readonly string[]): readonly string[] => [...new Set(refs)];

export interface CentralJudgmentMaterialBody {
  readonly role: typeof CENTRAL_JUDGMENT_VIEW_ROLE;
  readonly scopeHash: string;
  readonly operationId: string;
  readonly resultRef: string;
  readonly originalRef: string;
  readonly originalHash: string;
  readonly text: string;
  readonly originalChars: number;
  readonly omittedChars: number;
  readonly sourceRefs: readonly string[];
  /** Omitted distinct reference identities; duplicates are not new sources. */
  readonly sourceRefsOmitted: number;
  readonly aliases: readonly string[];
  /** Includes mandatory original/result identities in the compact alias set. */
  readonly aliasesOmitted: number;
  readonly interpretation: typeof INTERPRETATION;
}

export interface CentralJudgmentMaterialInput {
  readonly scope: string;
  readonly operationId: string;
  readonly resultRef: string;
  readonly originalRef: string;
  readonly originalHash: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly aliases: readonly string[];
}

function bodyValid(value: unknown): value is CentralJudgmentMaterialBody {
  return fields(value, ["role", "scopeHash", "operationId", "resultRef", "originalRef", "originalHash", "text", "originalChars", "omittedChars",
    "sourceRefs", "sourceRefsOmitted", "aliases", "aliasesOmitted", "interpretation"])
    && Reflect.ownKeys(value).length === 14 && value.role === CENTRAL_JUDGMENT_VIEW_ROLE && hash(value.scopeHash)
    && identity(value.operationId) && reference(value.resultRef) && reference(value.originalRef) && hash(value.originalHash)
    && prose(value.text) && value.text.length <= VIEW_TEXT_CHARS && sequence(value.originalChars) && value.originalChars <= MAX_MATERIAL_CHARS
    && sequence(value.omittedChars) && value.originalChars - value.text.length === value.omittedChars
    && (value.omittedChars === 0 || value.text.length >= VIEW_TEXT_CHARS - 1)
    && references(value.sourceRefs) && value.sourceRefs.length <= VIEW_REFS && sequence(value.sourceRefsOmitted)
    && value.sourceRefs.length + value.sourceRefsOmitted <= MAX_REFS
    && (value.sourceRefsOmitted === 0 || value.sourceRefs.length === VIEW_REFS)
    && references(value.aliases) && value.aliases.length <= VIEW_REFS && sequence(value.aliasesOmitted)
    && value.aliases.length + value.aliasesOmitted <= MAX_REFS + 2
    && (value.aliasesOmitted === 0 || value.aliases.length === VIEW_REFS)
    && value.aliases[0] === value.originalRef && value.aliases.includes(value.resultRef)
    && (value.originalRef === value.resultRef || value.aliases[1] === value.resultRef) && value.interpretation === INTERPRETATION;
}

function materialSources(body: CentralJudgmentMaterialBody): readonly string[] {
  return unique([body.operationId, body.resultRef, body.originalRef, ...body.sourceRefs, ...body.aliases]);
}

function preview(value: string): string {
  const selected = value.slice(0, VIEW_TEXT_CHARS), last = selected.charCodeAt(selected.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? selected.slice(0, -1) : selected;
}

/** The caller first authenticates the original receipt/material. This view binds
 * that public judgment without changing its original body or result identity. */
export function createCentralJudgmentMaterial(input: CentralJudgmentMaterialInput): CentralRuntimeMaterial {
  if (!coordinationScopeValid(input.scope) || !text(input.scope, 512)
    || !prose(input.text) || !referenceList(input.sourceRefs) || !referenceList(input.aliases)) throw new Error("central_judgment_material_invalid");

  const originalSources = unique(input.sourceRefs), originalAliases = unique([input.originalRef, input.resultRef, ...input.aliases]);
  const selectedText = preview(input.text), sourceRefs = originalSources.slice(0, VIEW_REFS), aliases = originalAliases.slice(0, VIEW_REFS);
  const body: CentralJudgmentMaterialBody = { role: CENTRAL_JUDGMENT_VIEW_ROLE, scopeHash: contentHashOf(input.scope),
    operationId: input.operationId, resultRef: input.resultRef, originalRef: input.originalRef, originalHash: input.originalHash,
    text: selectedText, originalChars: input.text.length, omittedChars: input.text.length - selectedText.length,
    sourceRefs, sourceRefsOmitted: originalSources.length - sourceRefs.length,
    aliases, aliasesOmitted: originalAliases.length - aliases.length, interpretation: INTERPRETATION };
  if (!bodyValid(body)) throw new Error("central_judgment_material_invalid");

  const materialRefs = materialSources(body), serialized = canonicalJson(body);
  if (!references(materialRefs) || serialized.length > MAX_MATERIAL_CHARS) throw new Error("central_judgment_material_capacity");

  return { ref: `${CENTRAL_JUDGMENT_VIEW_PREFIX}${contentHashOf(body)}`, kind: "work_result", text: serialized, sourceRefs: materialRefs };
}

/** Only this exact outer namespace is decoded; ordinary user/source JSON never
 * becomes metadata merely by containing a matching role or originalRef. */
export function readCentralJudgmentMaterial(material: CentralRuntimeMaterial): CentralJudgmentMaterialBody | undefined {
  try {
    const prototype = Object.getPrototypeOf(material);
    if (!fields(material, ["ref", "kind", "text", "sourceRefs"]) || Reflect.ownKeys(material).length !== 4
      || prototype !== Object.prototype && prototype !== null
      || material.kind !== "work_result" || typeof material.ref !== "string" || !material.ref.startsWith(CENTRAL_JUDGMENT_VIEW_PREFIX)
      || !hash(material.ref.slice(CENTRAL_JUDGMENT_VIEW_PREFIX.length)) || !prose(material.text) || !references(material.sourceRefs)) return undefined;

    const body: unknown = JSON.parse(material.text);
    if (!bodyValid(body) || material.text !== canonicalJson(body)
      || material.ref !== `${CENTRAL_JUDGMENT_VIEW_PREFIX}${contentHashOf(body)}`
      || canonicalJson(material.sourceRefs) !== canonicalJson(materialSources(body))) return undefined;

    return body;
  } catch {
    // Malformed optional context proves no judgment identity or alias authority.
    return undefined;
  }
}

/** Business sources and the operation identity are not transitively controls.
 * Only the view and its explicitly bound result/original aliases are marked. */
export function centralJudgmentControlRefs(materials: readonly CentralRuntimeMaterial[]): ReadonlySet<string> {
  const refs = new Set<string>();

  for (const material of materials) {
    const body = readCentralJudgmentMaterial(material);
    if (body === undefined) continue;
    for (const ref of [material.ref, ...body.aliases, body.originalRef, body.resultRef]) refs.add(ref);
  }

  return refs;
}

export function isCentralJudgmentContextMaterial(material: CentralRuntimeMaterial, refs?: ReadonlySet<string>): boolean {
  return refs?.has(material.ref) === true || readCentralJudgmentMaterial(material) !== undefined;
}
