import type { ProviderRecoveryHint } from "../../ports/provider.js";
import { isProviderRecoveryHint } from "../../domain/provider-recovery.js";

type SingleHint = Exclude<ProviderRecoveryHint, { readonly kind: "all" }>;

const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Only standard Retry-After. Vendor reset headers have incompatible units and are not guessed. */
function retryAfterHint(raw: string | null): SingleHint | undefined {
  if (raw === null || raw.length > 128) return undefined;

  const value = raw.trim();
  if (/^\d+$/u.test(value)) {
    const hint = { kind: "after" as const, delayMs: Number(value) * 1000, source: "retry_after" as const };
    return isProviderRecoveryHint(hint) ? hint : undefined;
  }

  if (!HTTP_DATE.test(value)) return undefined;

  const atMs = Date.parse(value), hint = { kind: "at" as const, atMs, source: "retry_after" as const };

  // Date.parse normalizes invalid calendar dates and ignores a mismatched weekday.
  return isProviderRecoveryHint(hint) && new Date(atMs).toUTCString() === value ? hint : undefined;
}

/** Both constraints apply. Relative and absolute values remain separate until
 * the runtime can take max(reset, now + delay) once with its injected clock. */
export function httpRecoveryHint(retryAfter: string | null,
  quotaReset?: Extract<ProviderRecoveryHint, { readonly kind: "at" }>): ProviderRecoveryHint | undefined {
  const header = retryAfterHint(retryAfter);
  if (header === undefined) return quotaReset;
  if (quotaReset === undefined) return header;
  return header.kind === "after" ? { kind: "all", atMs: quotaReset.atMs, delayMs: header.delayMs,
    source: "retry_after_and_quota_reset" } : header.atMs >= quotaReset.atMs ? header : quotaReset;
}
