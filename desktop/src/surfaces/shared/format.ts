/**
 * Tiny formatting helpers used by the team surface.
 * No date-fns, no Intl.RelativeTimeFormat gymnastics — just enough
 * for the spec's "≤ 80 字" / "≤ 24 字" caps and a short duration stamp.
 */

export const MAX_SUMMARY_CHARS = 24;
export const MAX_ONELINER_CHARS = 80;

export function clampText(value: string | undefined, max: number): string {
  if (!value) return '';
  // Collapse newlines + double spaces so the truncation reads as a
  // single line on the card.
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}
