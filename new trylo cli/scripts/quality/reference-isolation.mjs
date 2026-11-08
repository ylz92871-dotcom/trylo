import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(new URL("./reference-isolation.json", import.meta.url), "utf8"));

export function hasReferenceImport(text) {
  return policy.importMarkers.some((marker) => text.includes(marker));
}

export function hasReferenceDependency(text) {
  return policy.dependencyMarkers.some((marker) => text.includes(marker));
}
