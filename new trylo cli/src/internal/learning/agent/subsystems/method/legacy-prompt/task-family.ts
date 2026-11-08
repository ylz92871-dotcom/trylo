import type { TaskFamily, VersionPins } from "../../../../domains/shared/types.js";

export function taskFamiliesComparable(left: TaskFamily, right: TaskFamily): boolean {
  if (left.intentClass !== right.intentClass) {
    return false;
  }

  if (left.checkKind !== right.checkKind) {
    return false;
  }

  if (
    left.language !== undefined &&
    right.language !== undefined &&
    left.language !== right.language
  ) {
    return false;
  }

  if (
    left.repoKind !== undefined &&
    right.repoKind !== undefined &&
    left.repoKind !== right.repoKind
  ) {
    return false;
  }

  if (
    left.checkSchema !== undefined &&
    right.checkSchema !== undefined &&
    left.checkSchema !== right.checkSchema
  ) {
    return false;
  }

  return true;
}

export function incomparableReasons(left: TaskFamily, right: TaskFamily): string[] {
  const reasons: string[] = [];

  if (left.intentClass !== right.intentClass) {
    reasons.push("intentClass");
  }

  if (left.checkKind !== right.checkKind) {
    reasons.push("checkKind");
  }

  if (
    left.language !== undefined &&
    right.language !== undefined &&
    left.language !== right.language
  ) {
    reasons.push("language");
  }

  if (
    left.repoKind !== undefined &&
    right.repoKind !== undefined &&
    left.repoKind !== right.repoKind
  ) {
    reasons.push("repoKind");
  }

  if (
    left.checkSchema !== undefined &&
    right.checkSchema !== undefined &&
    left.checkSchema !== right.checkSchema
  ) {
    reasons.push("checkSchema");
  }

  return reasons;
}

export function versionConfounders(left: VersionPins, right: VersionPins): string[] {
  const confounders: string[] = [];

  if (left.model !== right.model) {
    confounders.push("model");
  }

  if (left.toolset !== right.toolset) {
    confounders.push("toolset");
  }

  if (left.codeBaseline !== right.codeBaseline) {
    confounders.push("codeBaseline");
  }

  if (left.workflow !== right.workflow) {
    confounders.push("workflow");
  }

  return confounders;
}
