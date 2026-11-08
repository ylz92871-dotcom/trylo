import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import { isRedactedTopicData } from "../learning-topics/confidentiality.js";
import { readSessionContentAddress } from "../learning-content/sources/session-address.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";

export interface CentralBusinessSourceDirectory {
  readonly sessionId: string;
  readonly turnId: string;
  readonly through: number;
  readonly noticeRef: string;
  readonly lastSourceRef: string;
  readonly lastSourceHash: string;
  readonly shownEntries: number;
  readonly shownRoles: readonly string[];
  readonly lastShownRole: string | null;
  readonly taskPreview?: { readonly role: string; readonly journalSequence: number; readonly text: string; readonly omittedChars: number };
}

interface Entry {
  readonly ref: string;
  readonly address: string;
  readonly journalSequence: number;
  readonly turnId: string;
  readonly role: string;
  readonly preview: string;
  readonly previewOmittedChars: number;
}

const reference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Bind a source-owned, turn-qualified record address to its actual host
 * directory. Keep the immutable page and its provenance bytes unchanged. */
export function centralBusinessSourceBodyNotice(material: CentralRuntimeMaterial,
  directories: readonly CentralRuntimeMaterial[]): string | undefined {
  if (material.kind !== "source" || !material.ref.startsWith("central-source-page:") || isCentralUnreadNavigationMaterial(material)) return undefined;

  let page: unknown;

  try { page = JSON.parse(material.text); } catch { return undefined; }

  if (typeof page !== "object" || page === null || !("owner" in page) || page.owner !== "session"
    || !("ref" in page) || typeof page.ref !== "string") return undefined;

  const address = readSessionContentAddress(page.ref);
  if (address?.turnId === undefined || address.journalSequence === undefined) return undefined;

  for (const directory of directories) {
    if (!directory.ref.startsWith("central-business-catalog:")) continue;
    const business = centralBusinessSourceDirectory(directory);
    if (business?.sessionId === address.sessionId && business.turnId === address.turnId
      && address.journalSequence <= business.through) return business.noticeRef;
  }

  return undefined;
}

function entry(value: unknown): value is Entry {
  const optional = ["originalRef", "originalSourceHash"].filter(key => typeof value === "object" && value !== null && Object.hasOwn(value, key));
  return fields(value, ["ref", "address", "journalSequence", "turnId", "role", "totalChars", "preview", "previewOmittedChars", ...optional])
    && reference(value.ref) && reference(value.address) && sequence(value.journalSequence) && reference(value.turnId)
    && text(value.role, 128) && sequence(value.totalChars) && typeof value.preview === "string" && value.preview.length <= 4096
    && sequence(value.previewOmittedChars) && (optional.length === 0 || optional.length === 2
      && reference(value.originalRef) && hash(value.originalSourceHash));
}

function taskPreview(entries: readonly Entry[]): CentralBusinessSourceDirectory["taskPreview"] {
  // Prefer the original public task handback over tool arguments. The source
  // owner already projected secrets; retain the same path/credential policy.
  for (const role of ["assistant_text", "tool_call", "user_text", "user_input"]) {
    const candidate = entries.find(row => row.role === role && row.preview.trim() && isRedactedTopicData(row.preview, []));
    if (candidate === undefined) continue;
    const text = candidate.preview.slice(0, 160), omittedChars = candidate.previewOmittedChars + candidate.preview.length - text.length;
    if (Number.isSafeInteger(omittedChars)) return { role, journalSequence: candidate.journalSequence, text, omittedChars };
  }
  return undefined;
}

/** Show only the original host's bounded directory identity. Neither its preview
 * nor the source addresses inside that directory are delivered source bodies. */
export function centralBusinessSourceDirectory(material: CentralRuntimeMaterial): CentralBusinessSourceDirectory | undefined {
  if (material.kind !== "source" || material.ref !== `central-business-catalog:${contentHashOf(material.text)}`) return undefined;

  let value: unknown;

  try { value = JSON.parse(material.text); } catch { return undefined; } // Prose cannot establish a host directory identity.

  if (!fields(value, ["role", "sessionId", "turnId", "noticeRef", "through", "lastSourceRef", "lastSourceHash", "entries", "maximumShownEntries"])
    || value.role !== "host_normal_turn_source_catalog_not_read_body" || !reference(value.sessionId) || !reference(value.turnId)
    || !sequence(value.through) || !reference(value.lastSourceRef) || !hash(value.lastSourceHash)
    || !sequence(value.maximumShownEntries) || value.maximumShownEntries < 1 || value.maximumShownEntries > 64
    || !Array.isArray(value.entries) || value.entries.length > value.maximumShownEntries || !value.entries.every(entry)) return undefined;

  const entries = value.entries;
  const turnId = value.turnId, through = value.through;
  if (entries.some(row => row.turnId !== turnId || row.journalSequence > through)
    || new Set(entries.map(row => row.ref)).size !== entries.length
    || entries.some((row, index) => index > 0 && row.journalSequence <= entries[index - 1]!.journalSequence)) return undefined;

  const noticeRef = `central-business-turn:${contentHashOf({ sessionId: value.sessionId, turnId: value.turnId,
    journalSequence: value.through, sourceHash: value.lastSourceHash })}`;
  if (value.noticeRef !== noticeRef || canonicalJson(material.sourceRefs)
    !== canonicalJson([noticeRef, ...entries.flatMap(row => [row.ref, row.address])])) return undefined;

  const last = entries.at(-1);
  const preview = taskPreview(entries);

  return { sessionId: value.sessionId, turnId: value.turnId, through: value.through, noticeRef,
    lastSourceRef: value.lastSourceRef, lastSourceHash: value.lastSourceHash, shownEntries: entries.length,
    shownRoles: [...new Set(entries.map(row => row.role))],
    lastShownRole: last?.ref === value.lastSourceRef && last.journalSequence === value.through ? last.role : null,
    ...(preview === undefined ? {} : { taskPreview: preview }) };
}
