import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { TaskSourcePage } from "../learning-content/task-source-pages.js";
import { TOPIC_EVIDENCE_ORIGINS } from "../../learning/domains/shared/topics/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import { centralMaterialFromPage } from "./deliberation-material.js";

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const reference = (value: unknown): value is string => text(value, 2048);

/** Recognize only the original host's complete canonical page wrapper. Reading
 * its business text grants no source, scope or evidence authority to arbitrary JSON. */
export function readOrganizationQuerySource(material: CentralRuntimeMaterial, scope: string): TaskSourcePage | undefined {
  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (typeof body !== "object" || body === null) return undefined;

  const extra = ["originalSource", "nextRef"].filter(key => Object.hasOwn(body, key));
  if (!fields(body, ["role", "ref", "originalRef", "origin", "originalScope", "start", "end", "totalChars", "text",
    "sourceHash", "coordinate", "owner", "complete", ...extra]) || body.role !== "actual_source_fragment_not_full_source"
    || body.originalScope !== scope || !reference(body.ref) || !reference(body.originalRef)
    || typeof body.origin !== "string" || !TOPIC_EVIDENCE_ORIGINS.some(origin => origin === body.origin)
    || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
    || body.end < body.start || body.end > body.totalChars || typeof body.text !== "string" || body.text.length !== body.end - body.start
    || !hash(body.sourceHash) || !fields(body.coordinate, ["runId", "sequence"])
    || !reference(body.coordinate.runId) || !sequence(body.coordinate.sequence)
    || !["session", "board", "feedback", "domain_feedback"].includes(String(body.owner))) return undefined;

  const original = body.originalSource;
  if (original !== undefined && (!fields(original, ["ref", "runId", "sequence", "sourceHash"])
    || !reference(original.ref) || !reference(original.runId) || !sequence(original.sequence) || !hash(original.sourceHash))) return undefined;

  const page: TaskSourcePage = { ref: body.ref, originalRef: body.originalRef,
    origin: body.origin as TaskSourcePage["origin"], originalScope: scope, start: body.start, end: body.end, totalChars: body.totalChars,
    text: body.text, sourceHash: body.sourceHash, coordinate: { runId: body.coordinate.runId, sequence: body.coordinate.sequence },
    owner: body.owner as TaskSourcePage["owner"], ...(original === undefined ? {} : { originalSource: original as NonNullable<TaskSourcePage["originalSource"]> }) };

  try { return canonicalJson(centralMaterialFromPage(page)) === canonicalJson(material) ? page : undefined; }
  catch { return undefined; }
}

/** This is a privacy-check view only. The original query, packet and material
 * are never rewritten. Only a complete original wrapper's validated scope slot
 * may be substituted; every other character keeps the original public policy. */
export function originalScopeQueryPrivacyView(purpose: string, materials: readonly CentralRuntimeMaterial[], scope: string): string | undefined {
  let view = purpose, matched = false;

  for (const material of materials) {
    if (readOrganizationQuerySource(material, scope) === undefined) continue;

    // The old builder quoted at most 900 characters plus this fixed disclosure.
    // Verify that exact old excerpt against the complete archived page; never
    // parse or grant authority to an arbitrary partial JSON string in a query.
    const fragment = material.text.length <= 900 ? material.text
      : `${material.text.slice(0, 900)} [retrieval context excerpt; original source references remain readable]`;
    const slot = `"originalScope":${JSON.stringify(scope)}`;
    if (!view.includes(fragment) || !fragment.includes(slot) || fragment.indexOf(slot) !== fragment.lastIndexOf(slot)) continue;

    const checked = fragment.replace(slot, '"originalScope":"[canonical_scope]"');

    view = view.split(fragment).join(checked);
    matched = true;
  }

  return matched ? view : undefined;
}
