import type { CentralResponseForecastQuery } from "./prediction-input.js";
import type { CentralTimingTarget } from "./timing-contract.js";

/** Carry the source's actual outcome support into deadline censoring. Pending
 * posterior-mean ranges and Gaussian uncertainty are deliberately ineligible. */
export function centralResponseTimingTarget(query: CentralResponseForecastQuery, target: CentralTimingTarget): CentralTimingTarget {
  return target?.kind === "deadline" && target.grossSupport === undefined && query.grossSupport !== undefined
    ? { ...target, grossSupport: query.grossSupport } : target;
}
