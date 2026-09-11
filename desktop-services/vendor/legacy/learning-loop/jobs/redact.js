'use strict';

/*
 * redact.js
 *
 * L6 (34 §4.1, §10 T10) errorText scrubbing. Hard rules:
 *   - max 200 chars
 *   - never carry raw Skill / Memory / full-prompt bodies
 *   - never carry obvious secret-like blobs (long base64, JSON body)
 *
 * The redaction is conservative: any line that looks like a file path under
 * ~/.hermes/skills or ~/.hermes/memory is replaced with "<redacted-body>".
 * The function is pure / sync so it can be called inline.
 */

const MAX_LEN = 200;
const BODY_HINT = /(?:^|\n)\s*(?:skill|memory|prompt|body|content|frontmatter)\s*[:=]/i;
const PATH_HINT = /(?:~?\/?\.hermes\/(?:skills|memory)|SKILL\.md|MEMORY\.md)/i;
const LONG_BLOB = /[A-Za-z0-9+/=]{120,}/;

function redactErrorText(s) {
  if (s == null) return '';
  let text = typeof s === 'string' ? s : String(s);
  if (PATH_HINT.test(text)) {
    return 'redacted:path';
  }
  if (BODY_HINT.test(text)) {
    // Keep only the first line before any body-like field.
    const firstLine = text.split(/\r?\n/, 1)[0];
    text = firstLine || 'redacted:body';
  }
  if (LONG_BLOB.test(text)) {
    return 'redacted:blob';
  }
  if (text.length > MAX_LEN) {
    text = text.slice(0, MAX_LEN - 3) + '...';
  }
  return text;
}

module.exports = { redactErrorText, MAX_LEN };
