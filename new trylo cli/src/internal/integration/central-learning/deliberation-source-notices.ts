import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, sequence, text } from "../../validation/json-shape.js";

export interface CentralSourceCatalogNotice {
  readonly noticeRef: string;
  readonly readRef: string;
  readonly issueId: string;
  readonly owner: string;
  readonly problem: string;
  readonly reportCount: number;
}

interface CatalogEntry extends Omit<CentralSourceCatalogNotice, "noticeRef"> {
  readonly role: "original_report" | "known_learning_handoff_not_new_business";
  readonly noticeRef: string | null;
}

const notice = /^central-runtime-issue-notice:([a-f0-9]{64})$/;
const issue = /^central-runtime-issue:[a-f0-9]{64}$/;

function isEntry(value: unknown): value is CatalogEntry {
  if (!fields(value, ["issueId", "owner", "problem", "reportCount", "role", "noticeRef", "readRef"])
    || !text(value.issueId, 512) || !text(value.owner, 256) || !text(value.problem, 200)
    || !sequence(value.reportCount) || value.reportCount < 1 || typeof value.readRef !== "string" || !issue.test(value.readRef)) return false;

  if (value.role === "known_learning_handoff_not_new_business") return value.noticeRef === null;

  if (value.role !== "original_report" || typeof value.noticeRef !== "string") return false;

  const address = notice.exec(value.noticeRef);

  return address !== null && value.readRef === `central-runtime-issue:${address[1]}`;
}

/** Only the original host catalog can acknowledge its actually displayed
 * notice positions. Its entries are not a read of the underlying reports. */
export function selectedCentralSourceNotices(material: CentralRuntimeMaterial,
  selectedRefs: readonly string[]): readonly CentralSourceCatalogNotice[] {
  if (material.kind !== "source" || material.ref !== `central-runtime-catalog:${contentHashOf(material.text)}`) return [];

  let value: unknown;

  try { value = JSON.parse(material.text); } catch { return []; } // Prose is not an authenticated catalog envelope.

  if (!fields(value, ["role", "availableIssues", "shownIssues", "nextReadRef", "entries"])
    || value.role !== "original_report_catalog_not_read_body" || !sequence(value.availableIssues) || !sequence(value.shownIssues)
    || !Array.isArray(value.entries) || value.entries.length > 64 || value.entries.length !== value.shownIssues
    || value.availableIssues < value.shownIssues || !value.entries.every(isEntry)
    || value.nextReadRef !== null && (typeof value.nextReadRef !== "string" || !/^central-runtime-issue-catalog:\d+$/.test(value.nextReadRef))) return [];

  const entries = value.entries;
  if (new Set(entries.map(entry => entry.issueId)).size !== entries.length) return [];

  const originals = entries.filter(entry => entry.role === "original_report");
  if (new Set(originals.map(entry => entry.noticeRef)).size !== originals.length) return [];

  if (canonicalJson(material.sourceRefs) !== canonicalJson(originals.map(entry => entry.noticeRef))) return [];

  return selectedRefs.flatMap(ref => {
    const entry = originals.find(row => row.noticeRef === ref);
    return entry === undefined ? [] : [{ noticeRef: ref, readRef: entry.readRef, issueId: entry.issueId,
      owner: entry.owner, problem: entry.problem, reportCount: entry.reportCount }];
  });
}
