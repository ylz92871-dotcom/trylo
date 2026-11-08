/** Captions are presentation only; the review owns its complete rationale. */
export const MAX_SCOPE_DESCRIPTION_CHARS = 1500;
export const MAX_SCOPE_CAPTION_CHARS = 240;

export function scopeCaption(value: string, maxChars = MAX_SCOPE_DESCRIPTION_CHARS): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError("invalid_scope_caption_limit");

  if (value.length <= maxChars) return value;

  let end = maxChars - 1;
  // The persisted limit counts UTF-16 units; do not split a supplementary
  // character while reserving one unit for the visible omission marker.
  const preceding = value.charCodeAt(end - 1), following = value.charCodeAt(end);
  if (preceding >= 0xD800 && preceding <= 0xDBFF && following >= 0xDC00 && following <= 0xDFFF) end -= 1;

  return value.slice(0, end) + "…";
}
