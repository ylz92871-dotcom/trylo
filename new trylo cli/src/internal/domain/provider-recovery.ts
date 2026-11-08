import type { ProviderRecoveryHint } from "../ports/provider.js";
import { fields } from "../validation/json-shape.js";

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
export const isProviderRecoveryMilliseconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && value <= MAX_DATE_MILLISECONDS;

/** No clock or inference: the consumer must also validate any now + delay result. */
export function isProviderRecoveryHint(value: unknown): value is ProviderRecoveryHint {
  if (fields(value, ["kind", "delayMs", "source"])) return value.kind === "after"
    && value.source === "retry_after" && isProviderRecoveryMilliseconds(value.delayMs);
  if (fields(value, ["kind", "atMs", "source"])) return value.kind === "at"
    && (value.source === "retry_after" || value.source === "quota_reset") && isProviderRecoveryMilliseconds(value.atMs);
  return fields(value, ["kind", "atMs", "delayMs", "source"]) && value.kind === "all"
    && value.source === "retry_after_and_quota_reset" && isProviderRecoveryMilliseconds(value.atMs) && isProviderRecoveryMilliseconds(value.delayMs);
}
