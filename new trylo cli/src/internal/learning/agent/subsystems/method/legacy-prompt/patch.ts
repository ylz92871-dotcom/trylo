import { canonicalJson, sha256Hex } from "../../../../domains/shared/hash.js";
import { scanForbiddenText } from "../../../../domains/shared/forbidden-scan.js";
import {
  type PromptOp,
  type PromptSection,
  PROMPT_SECTIONS,
} from "../../../../domains/shared/types.js";

export const FORBIDDEN_PATCH_CLAIMS = [
  "permission",
  "skip_approval",
  "allow_network",
  "tool_switch",
  "tool_install",
  "workflow_topology",
] as const;

export type PromptSections = Partial<Record<PromptSection, string>>;

export function canonicalPatch(ops: readonly PromptOp[]): string {
  return canonicalJson(ops);
}

export function patchesEquivalent(
  left: readonly PromptOp[],
  right: readonly PromptOp[],
): boolean {
  return canonicalPatch(left) === canonicalPatch(right);
}

export function forbiddenClaimsIn(
  claims: readonly string[],
): readonly string[] {
  return scanForbiddenText(claims);
}

export function forbiddenClaimsInOps(ops: readonly PromptOp[]): readonly string[] {
  const texts: string[] = [];

  for (const op of ops) {
    if (op.op === "replace_section") {
      texts.push(op.section, op.fromHash, op.toHash);
    } else if (op.op === "add_constraint") {
      texts.push(op.constraintHash);
    } else {
      texts.push(...op.order);
    }
  }

  return scanForbiddenText(texts);
}

export function structuredPromptDiff(
  baseline: PromptSections,
  candidate: PromptSections,
): PromptOp[] {
  const ops: PromptOp[] = [];

  for (const section of PROMPT_SECTIONS) {
    const fromText = baseline[section];
    const toText = candidate[section];
    if (fromText !== undefined && toText !== undefined && fromText !== toText) {
      ops.push({
        op: "replace_section",
        section,
        fromHash: sha256Hex(fromText).slice(0, 16),
        toHash: sha256Hex(toText).slice(0, 16),
      });
    } else if (fromText === undefined && toText !== undefined && section === "constraint") {
      ops.push({
        op: "add_constraint",
        constraintHash: sha256Hex(toText).slice(0, 16),
      });
    }
  }

  return ops;
}

export function nearDuplicatePatches(
  left: readonly PromptOp[],
  right: readonly PromptOp[],
): boolean {
  return patchShape(left) === patchShape(right);
}

function patchShape(ops: readonly PromptOp[]): string {
  return ops
    .map((op) => {
      if (op.op === "replace_section") {
        return `${op.op}:${op.section}`;
      }

      if (op.op === "add_constraint") {
        return op.op;
      }

      return `${op.op}:${op.order.join(",")}`;
    })
    .join("|");
}
