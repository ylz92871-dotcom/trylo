/** Promoted from Trylo's RW2 research allocateLearning; no research/runtime dependencies. */
export type DomainValueCurve = { readonly domain: string; readonly values: readonly number[] };

export type DomainQuota = { readonly domain: string; readonly quota: number };

type Entry = { readonly value: number; readonly allocations: readonly DomainQuota[] };

/** Exact static additive quota DP, up to floating-point tolerance. No within-domain asset selection. */
export function allocateLearning(curves: readonly DomainValueCurve[], budget: number) {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 8 || !Array.isArray(curves) || curves.length > 8) {
    throw new RangeError("allocation_input_invalid");
  }

  const names = new Set<string>();

  for (const curve of curves) {
    if (!curve || !curve.domain || names.has(curve.domain) || !Array.isArray(curve.values)
      || curve.values.length === 0 || curve.values.length > 9) throw new RangeError("allocation_curve_invalid");
    for (const value of curve.values) if (!Number.isFinite(value)) throw new RangeError("allocation_value_invalid");
    names.add(curve.domain);
  }

  let frontier = new Map<number, Entry>([[0, { value: 0, allocations: [] }]]);

  for (const curve of curves) {
    const next = new Map<number, Entry>();

    for (const [used, entry] of frontier) {
      for (let quota = 0; quota < curve.values.length && used + quota <= budget; quota += 1) {
        const value = entry.value + curve.values[quota]!;
        if (!Number.isFinite(value)) throw new RangeError("allocation_value_overflow");
        const previous = next.get(used + quota);
        if (previous === undefined || value > previous.value + 1e-12) {
          next.set(used + quota, { value, allocations: [...entry.allocations, { domain: curve.domain, quota }] });
        }
      }
    }

    frontier = next;
  }

  let best: Entry | undefined, allocated = 0;

  for (const [used, entry] of frontier) {
    if (best === undefined || entry.value > best.value + 1e-12 || (Math.abs(entry.value - best.value) <= 1e-12 && used < allocated)) {
      best = entry;
      allocated = used;
    }
  }

  if (best === undefined) throw new Error("allocation_frontier_missing");

  return { ...best, allocated };
}
