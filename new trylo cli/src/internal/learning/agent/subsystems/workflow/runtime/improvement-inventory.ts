import type { WorkflowImprovementEvidence } from "../improvement/contracts.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_INVENTORY_BYTES = 24_000;

/** Keep whole public records. Generic tool clipping must never split evidence meanings or process contracts. */
export function boundWorkflowImprovementInventory<A, R, U>(input: {
  readonly available: readonly A[]; readonly recentIssues: readonly R[];
  readonly evidence: readonly WorkflowImprovementEvidence[]; readonly uses: readonly U[];
}) {
  const selected = { available: [] as A[], recentIssues: [] as R[], evidence: [] as WorkflowImprovementEvidence[], uses: [] as U[] };
  const priority = (item: WorkflowImprovementEvidence) => item.kind === "user_correction" ? 0 : item.kind === "user_input" ? 1
    : item.kind === "quality_failure" ? 2 : item.kind === "tool_failure" ? 3 : item.kind === "tool_success" ? 4 : item.kind === "rework" ? 5 : 6;
  const evidence = [...input.evidence].reverse().sort((left, right) => priority(left) - priority(right));
  const sections = [
    { key: "evidence" as const, source: evidence, allowance: 12_000 },
    { key: "available" as const, source: [...input.available].reverse(), allowance: 6_000 },
    { key: "recentIssues" as const, source: [...input.recentIssues].reverse(), allowance: 3_000 },
    { key: "uses" as const, source: [...input.uses].reverse(), allowance: 1_500 },
  ];
  const omitted: Record<keyof typeof selected, number> = { available: 0, recentIssues: 0, evidence: 0, uses: 0 };
  const leftovers: { readonly key: keyof typeof selected; readonly item: unknown }[] = [];
  const append = (key: keyof typeof selected, item: unknown) => {
    // The key/source pairing is fixed above; no value or reference is shortened here.
    (selected[key] as unknown[]).push(item);
  };

  for (const section of sections) {
    let used = 0;
    for (const item of section.source) {
      const size = bytes(item) + 1;
      if (used + size <= section.allowance) {
        append(section.key, item);
        used += size;
      }
      else leftovers.push({ key: section.key, item });
    }
  }

  // A complete long process contract may exceed its fair first-pass share. Give
  // empty sections a chance before routine evidence consumes every spare byte.
  leftovers.sort((left, right) => Number(selected[left.key].length > 0) - Number(selected[right.key].length > 0));

  for (const { key, item } of leftovers) {
    if (bytes(selected) + bytes(item) + 1 <= MAX_INVENTORY_BYTES) append(key, item);
    else omitted[key] += 1;
  }

  return { ...selected, omitted,
    inventoryNote: "Bounded public inventory; omitted records remain available to operator inspection. Evidence records and process contracts are never text-clipped. Unknown or omitted premises are not satisfied." };
}
