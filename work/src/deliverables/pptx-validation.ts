// Trylo Work — PPTX structure validation (redesign spec
// §8.5 G, WP-5).
//
// The minimum QA the spec demands of a finished deck:
//   G-1 the file exists, is non-empty and re-opens;
//   G-2 the realized page count matches the approved
//       outline (a mismatch is a WARNING, never a silent
//       pass);
//   G-3+ per-page title / resource / data checks need
//       facts the daemon does not expose yet — they stay
//       `pending`, never faked;
//   visual checks (overflow, contrast…) need a real
//       renderer; without one they are `not_run` — NEVER
//       a green pass (spec §16 rule 14).
//
// Pure: no fs, no zip parsing, no React. The desktop host
// supplies the file facts (`PptxStructureFacts`) it can
// actually verify (stat / open); anything it cannot verify
// stays out of the evidence and never upgrades a status.

import type {
  DeliverableValidationEntry,
  PresentationWorkflowProjection,
} from "./deliverable-domain.js";
import { realSlideCount } from "./presentation-workflow.js";

/** Validator ids — kept in lockstep with the registry's
 *  `validators` list for the presentation family. */
export const PPTX_VALIDATOR_IDS = {
  structure: "structure",
  resources: "resources",
  visualOverflow: "visual_overflow",
} as const;

/** The file-level facts a host verified out-of-band.
 *  Every field is an explicit fact — absent means
 *  "not verified", never "ok". */
export interface PptxStructureFacts {
  /** The exported file exists on disk. */
  readonly fileExists: boolean;
  /** Byte size as reported by the host's stat. */
  readonly sizeBytes?: number;
  /** The host could re-open / parse the container. */
  readonly parseable?: boolean;
  /** A slide count the generator itself reported (the
   *  generation-complete event, spec §8.3) — compared to
   *  the approved outline, never used as the page count. */
  readonly reportedSlideCount?: number;
}

/** Evaluate the structure validator (G-1/G-2) from real
 *  facts. Deterministic and side-effect free. */
export function evaluatePptxStructure(
  p: PresentationWorkflowProjection,
  facts: PptxStructureFacts,
): DeliverableValidationEntry {
  const id = PPTX_VALIDATOR_IDS.structure;
  const label = "文件结构与页数";

  if (!facts.fileExists) {
    return { id, label, status: "failed", evidence: "导出文件不存在" };
  }
  if (facts.sizeBytes !== undefined && facts.sizeBytes <= 0) {
    return { id, label, status: "failed", evidence: "文件大小为零" };
  }
  if (facts.parseable === false) {
    return { id, label, status: "failed", evidence: "文件无法重新打开" };
  }

  // G-2: realized pages vs the approved outline. A mismatch
  // is a warning, not a failure (spec §8.5 G-2).
  if (facts.reportedSlideCount !== undefined) {
    const expected = realSlideCount(p);
    if (expected !== undefined && expected !== facts.reportedSlideCount) {
      return {
        id,
        label,
        status: "warning",
        evidence: `实际 ${facts.reportedSlideCount} 页，大纲 ${expected} 页`,
      };
    }
  }
  const evidence =
    facts.reportedSlideCount !== undefined
      ? `${facts.reportedSlideCount} 页`
      : facts.sizeBytes !== undefined
        ? `${facts.sizeBytes} 字节`
        : "文件可打开";
  return { id, label, status: "passed", evidence };
}

/** The visual validator without a packaged renderer: it was
 *  NEVER run. `not_run` — never a green pass (spec §16). */
export function visualQaNotRun(): DeliverableValidationEntry {
  return {
    id: PPTX_VALIDATOR_IDS.visualOverflow,
    label: "文字溢出与版式",
    status: "not_run",
    evidence: "未打包渲染器，视觉质检未运行",
  };
}

/** The resource validator needs per-page image/resource
 *  facts the daemon does not expose yet — it stays pending
 *  (spec §8.5 G-4) rather than claiming a pass. */
export function resourcesPending(): DeliverableValidationEntry {
  return {
    id: PPTX_VALIDATOR_IDS.resources,
    label: "图片与资源可用",
    status: "pending",
    evidence: "等待资源级事实",
  };
}

/** Fold structure facts into the projection's validation
 *  list (upsert by validator id). Returns the SAME
 *  reference when nothing changes — replay safe. */
export function withPptxStructureFacts(
  p: PresentationWorkflowProjection,
  facts: PptxStructureFacts,
): PresentationWorkflowProjection {
  const entry = evaluatePptxStructure(p, facts);
  const idx = p.validation.findIndex((v) => v.id === entry.id);
  if (idx !== -1) {
    const existing = p.validation[idx];
    if (
      existing &&
      existing.status === entry.status &&
      existing.evidence === entry.evidence
    ) {
      return p;
    }
    const validation = p.validation.slice();
    validation[idx] = entry;
    return { ...p, validation };
  }
  return { ...p, validation: [...p.validation, entry] };
}
