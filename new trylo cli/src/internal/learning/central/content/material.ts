import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { CONTENT_MATERIAL_LIMITS as limits } from "./material-contract.js";
import type { ContentMaterialBatch, ContentMaterialResult, ContentPacket, ContentPacketInput, ContentSourceAlias } from "./material-contract.js";
import { isContentBatch, isContentPacketInput, isContentReferences } from "./material-parse.js";
import { fields } from "../../../validation/json-shape.js";

/** Only explicit source-address mappings expand a reference. Targets are original records,
 * not recursively interpreted aliases or text extracted from arbitrary context. */
export function expandContentSourceAliases(refs: readonly string[], aliases: readonly ContentSourceAlias[] = []): readonly string[] {
  const byRef = new Map(aliases.map(alias => [alias.ref, alias.recordRefs]));
  return [...new Set([...refs, ...refs.flatMap(ref => byRef.get(ref) ?? [])])];
}

/** Missing source text is a preparation gap, never evidence that no answer exists. */
export function contentRequestedRefs(input: ContentPacketInput): readonly string[] {
  const decisionRefs = input.focus?.decision.kind === "unreviewed" ? [] : input.focus?.decision.sourceRefs ?? [];
  return expandContentSourceAliases([...(input.requestedRefs ?? []), ...(input.focus?.reports.flatMap(report => report.evidenceRefs) ?? []),
    ...decisionRefs, ...input.requirements.flatMap(item => item.sourceRefs), ...input.answers.flatMap(item => item.supportRefs),
    ...input.materials.flatMap(item => item.recordRefs)], input.aliases);
}

/** Whole-material transport: the PA focus, requirements and support are never silently truncated. */
export function buildContentPacket(input: ContentPacketInput, maximumChars: number = limits.packetChars): ContentMaterialResult<ContentPacket> {
  if (!isContentPacketInput(input) || !Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > limits.packetChars) {
    return { ok: false, reason: "content_material_invalid" };
  }

  if (input.focus !== undefined && input.focus.scope !== input.scope || input.records.some(record => record.scope !== input.scope)) {
    return { ok: false, reason: "content_material_scope" };
  }

  const batch = mergeContentBatches([input]);
  if (!batch.ok) return batch;

  const requirements = new Set(batch.value.requirements.map(item => item.id)), answers = new Set(batch.value.answers.map(item => item.answerId));
  if (batch.value.materials.some(item => item.requirementIds.some(id => !requirements.has(id)) || item.answerIds.some(id => !answers.has(id)))) {
    return { ok: false, reason: "content_material_invalid" };
  }

  const requestedRefs = contentRequestedRefs(input);
  if (requestedRefs.length > limits.refs) return { ok: false, reason: "content_material_capacity" };

  const refs = new Set(batch.value.records.map(record => record.ref));
  const aliases = new Map((batch.value.aliases ?? []).map(alias => [alias.ref, alias.recordRefs]));
  const resolved = (ref: string) => refs.has(ref) || aliases.get(ref)?.every(target => refs.has(target)) === true;
  const body = { schemaVersion: 1 as const, scope: input.scope, domain: input.domain, boardSequence: input.boardSequence,
    ...(input.focus === undefined ? {} : { focus: input.focus }), ...batch.value,
    retrieval: { coverage: "bounded" as const, requestedRefs, missingRefs: requestedRefs.filter(ref => !resolved(ref)) } };
  const packet = { ...body, packetId: `content:${contentHashOf(body)}` };
  if (canonicalJson(packet).length > maximumChars) return { ok: false, reason: "content_material_capacity" };

  const copy = structuredClone(packet);

  freezeTree(copy);

  return { ok: true, value: copy };
}

/** Persistence boundary: validate shape, exact source closure and content identity before replay. */
export function readContentPacket(value: unknown): ContentMaterialResult<ContentPacket> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "content_material_invalid" };

  if (!fields(value, ["schemaVersion", "packetId", "scope", "domain", "boardSequence", "records", "requirements", "answers", "materials", "retrieval",
    ...("focus" in value ? ["focus"] : []), ...(Object.hasOwn(value, "aliases") ? ["aliases"] : [])]) || value.schemaVersion !== 1
    || typeof value.packetId !== "string" || !/^content:[a-f0-9]{64}$/.test(value.packetId)
    || !fields(value.retrieval, ["coverage", "requestedRefs", "missingRefs"]) || value.retrieval.coverage !== "bounded"
    || !isContentReferences(value.retrieval.missingRefs)) {
    return { ok: false, reason: "content_material_invalid" };
  }

  const input = { scope: value.scope, domain: value.domain, boardSequence: value.boardSequence,
    records: value.records, requirements: value.requirements, answers: value.answers, materials: value.materials,
    ...(value.focus === undefined ? {} : { focus: value.focus }),
    ...(Object.hasOwn(value, "aliases") ? { aliases: value.aliases } : {}), requestedRefs: value.retrieval.requestedRefs };
  if (!isContentPacketInput(input)) return { ok: false, reason: "content_material_invalid" };

  const rebuilt = buildContentPacket(input);
  if (!rebuilt.ok) return rebuilt;

  return canonicalJson(rebuilt.value) === canonicalJson(value) ? rebuilt : { ok: false, reason: "content_material_invalid" };
}

/** Exact identity conflicts fail closed, including two refs claiming the same original coordinate. */
export function mergeContentBatches(batches: readonly ContentMaterialBatch[]): ContentMaterialResult<ContentMaterialBatch> {
  if (!batches.every(isContentBatch)) return { ok: false, reason: "content_material_invalid" };

  const records = unique(batches.flatMap(batch => batch.records), item => item.ref);
  const requirements = unique(batches.flatMap(batch => batch.requirements), item => item.id);
  const answers = unique(batches.flatMap(batch => batch.answers), item => item.answerId);
  const materials = unique(batches.flatMap(batch => batch.materials), item => item.id);
  const aliases = unique(batches.flatMap(batch => batch.aliases ?? []), item => item.ref);
  if (records === undefined || requirements === undefined || answers === undefined || materials === undefined || aliases === undefined) {
    return { ok: false, reason: "content_material_conflict" };
  }

  const coordinates = new Set(records.map(record => canonicalJson([record.runId, record.sequence])));
  if (coordinates.size !== records.length) return { ok: false, reason: "content_material_conflict" };

  const recordRefs = new Set(records.map(record => record.ref));
  if (aliases.some(alias => recordRefs.has(alias.ref) && (alias.recordRefs.length !== 1 || alias.recordRefs[0] !== alias.ref))) {
    return { ok: false, reason: "content_material_conflict" };
  }

  if (records.length > limits.records || requirements.length > limits.requirements || answers.length > limits.answers
    || materials.length > limits.materials || aliases.length > limits.refs) {
    return { ok: false, reason: "content_material_capacity" };
  }

  return { ok: true, value: { records, requirements, answers, materials,
    ...(batches.some(batch => Object.hasOwn(batch, "aliases")) ? { aliases } : {}) } };
}

function unique<T>(items: readonly T[], key: (item: T) => string): readonly T[] | undefined {
  const selected = new Map<string, T>();

  for (const item of items) {
    const old = selected.get(key(item));
    if (old !== undefined && canonicalJson(old) !== canonicalJson(item)) return undefined;
    selected.set(key(item), item);
  }

  return [...selected.values()];
}

function freezeTree(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  Object.values(value).forEach(freezeTree);
  Object.freeze(value);
}
