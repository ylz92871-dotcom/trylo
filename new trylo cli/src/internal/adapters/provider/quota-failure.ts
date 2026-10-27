const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const QUOTA_CODES = new Set(["accountquotaexceeded", "quotaexceeded", "insufficient_quota"]);

/** Only an explicit structured allowance code changes retry policy. Provider
 * prose may contain prompts/keys: retain fixed vocabulary and validated dates.
 */
export function quotaFailureMessage(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const error = object(value.error) ? value.error : value;
  if (typeof error.code !== "string" || !QUOTA_CODES.has(error.code.toLowerCase())) return undefined;
  const message = typeof error.message === "string" ? error.message.slice(0, 8192) : "";
  const scope = /\b5-hour usage quota\b/i.test(message) ? "5-hour"
    : /\bdaily (?:usage )?quota\b/i.test(message) ? "daily"
      : /\bweekly (?:usage )?quota\b/i.test(message) ? "weekly"
        : /\bmonthly (?:usage )?quota\b/i.test(message) ? "monthly" : undefined;
  const reset = resetTimestamp(message);
  return ["quota_exceeded", ...(scope === undefined ? [] : [`window=${scope}`]), ...(reset === undefined ? [] : [`reset_at=${reset}`])].join("; ");
}

function resetTimestamp(message: string): string | undefined {
  const match = /\breset(?:s)? at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})(?!\d)/i.exec(message);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const parts = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number);
  const [y = 0, m = 0, d = 0, h = 0, min = 0, sec = 0, oh = 0, om = 0] = parts;
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59 || oh > 14 || om > 59 || (oh === 14 && om !== 0)) return undefined;
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}
