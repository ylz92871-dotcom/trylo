'use strict';

/*
 * evidence-builder.js
 *
 * Pure functions that construct a limited, sanitised Evidence Capsule from a
 * Trylo turn. VS Code agnostic — consumes structured data, returns plain objects.
 */

const crypto = require('node:crypto');

const CAPSULE_LIMITS = {
  schemaVersion: 1,
  maxWorkflowEntries: 24,
  maxFileHints: 40,
  maxChars: 12000,
  maxTaskGoal: 2000,
  maxResultSummary: 1000,
};

const EVENT_CATEGORY_ALLOWLIST = new Set([
  'search', 'read', 'edit', 'write', 'command', 'tool', 'verify', 'test',
  // TRYLO-L0-PATCH(dual-surface-spec §2.5): Work-surface tool categories from
  // Desktop's `toolCategory`. These let an office review carry Work evidence
  // (Office / browser / desktop tools) instead of lumping them under `tool`.
  'office', 'browser', 'desktop',
]);

function _isShadowOrTempPath(p) {
  if (!p || typeof p !== 'string') return false;
  const lower = p.toLowerCase();
  // Match shadow/temp/tmp/.trylo as path segments or suffixes, but do NOT
  // match the substring "temp" inside "templates/".
  if (/\/templates?\/|(^|[/\\])templates?([/\\]|$)/i.test(lower)) return false;
  // Escape the hyphen in the trailing char class to prevent `.-]` being
  // interpreted as a range (0x2E-0x5D) which would exclude `-` (0x2D).
  return /(^|[/\\._-])(shadow|temp|tmp|\.trylo)([/\\.\\-]|$)/i.test(lower);
}

function _isAbsolutePath(p) {
  if (!p || typeof p !== 'string') return false;
  // Reject drive-letter paths (C:\), UNC (\\server), POSIX absolute (/abs),
  // and parent-traversal (../  or ..\).
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/^[\\/]{2}/.test(p)) return true;
  if (/^\//.test(p)) return true;
  if (/(^|[/\\])\.\.([/\\]|$)/.test(p)) return true;
  return false;
}

function _stripSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/gi, '[REDACTED]')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/gi, '[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{36,})\b/gi, '[REDACTED]')
    .replace(/\b(Bearer\s+)([A-Za-z0-9._\-]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key\s*[:=]\s*)([^\s,;]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(token\s*[:=]\s*)([^\s,;]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(password\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]')
    .replace(/\b(secret\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]')
    .replace(/\b(credential[s]?\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]');
}

function _sanitiseToolEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = String(raw.category || '').toLowerCase().trim();
  if (!category) return null;
  if (!EVENT_CATEGORY_ALLOWLIST.has(category)) return null;
  const title = _stripSecrets(String(raw.title || category).slice(0, 200));
  const status = String(raw.status || 'unknown').toLowerCase().trim();
  return { category, title, status };
}

function _toRelativeFileHint(raw, workspaceRoot) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.replace(/\\/g, '/').trim();
  if (!p) return null;
  if (_isAbsolutePath(p)) {
    // Try to make it relative to workspaceRoot
    if (workspaceRoot) {
      const root = String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
      if (p.toLowerCase().startsWith(root.toLowerCase() + '/')) {
        p = p.slice(root.length + 1);
      } else {
        return null; // absolute path outside workspace — reject
      }
    } else {
      return null;
    }
  }
  if (_isShadowOrTempPath(p)) return null;
  return p.slice(0, 300);
}

function buildEvidenceCapsule(opts) {
  const {
    sessionId, turnId, workspaceHint, learnRequest, taskGoal,
    triggerKind, toolIterations, events, mode,
    fileHints, verification, resultSummary, reviewResolution,
    workspaceRoot,
  } = opts || {};

  const workflow = [];
  if (Array.isArray(events)) {
    for (const e of events) {
      const s = _sanitiseToolEvent(e);
      if (s && workflow.length < CAPSULE_LIMITS.maxWorkflowEntries) workflow.push(s);
    }
  }

  const safeFileHints = [];
  if (Array.isArray(fileHints)) {
    for (const f of fileHints) {
      const rel = _toRelativeFileHint(f, workspaceRoot);
      if (rel && safeFileHints.length < CAPSULE_LIMITS.maxFileHints) safeFileHints.push(rel);
    }
  }

  const safeVerification = [];
  if (Array.isArray(verification)) {
    for (const v of verification) {
      if (!v || typeof v !== 'string') continue;
      safeVerification.push(_stripSecrets(v).slice(0, 200));
    }
  }

  let summary = '';
  if (resultSummary && typeof resultSummary === 'string') {
    const cleaned = _stripSecrets(resultSummary).slice(0, CAPSULE_LIMITS.maxResultSummary);
    if (cleaned.length > 0) summary = cleaned;
  }

  let goal = '';
  if (taskGoal && typeof taskGoal === 'string') {
    const cleaned = _stripSecrets(taskGoal).slice(0, CAPSULE_LIMITS.maxTaskGoal);
    if (cleaned.length > 0) goal = cleaned;
  }

  const trigger = { kind: triggerKind || 'implicit' };
  if (typeof toolIterations === 'number' && toolIterations > 0) {
    trigger.toolIterations = toolIterations;
  }

  const source = {
    sessionId: String(sessionId || '').slice(0, 64),
    turnId: String(turnId || '').slice(0, 64),
    workspaceHint: _stripSecrets(String(workspaceHint || '')).slice(0, 100),
  };
  if (mode) source.mode = String(mode).slice(0, 16);

  const capsule = {
    schemaVersion: CAPSULE_LIMITS.schemaVersion,
    trigger,
    source,
    learnRequest: _stripSecrets(String(learnRequest || '')).slice(0, 2000),
    workflow,
    fileHints: safeFileHints,
    verification: safeVerification,
  };
  if (goal) capsule.taskGoal = goal;
  if (summary) capsule.resultSummary = summary;

  if (reviewResolution && typeof reviewResolution === 'object') {
    const rr = {
      accepted: Math.max(0, Number(reviewResolution.accepted) || 0),
      rejected: Math.max(0, Number(reviewResolution.rejected) || 0),
    };
    // Only include summary counts, never rejected file content
    capsule.reviewResolution = rr;
  }

  let json = JSON.stringify(capsule);
  while (json.length > CAPSULE_LIMITS.maxChars) {
    let trimmed = false;
    if (capsule.fileHints && capsule.fileHints.length > 0) { capsule.fileHints.pop(); trimmed = true; }
    if (!trimmed && capsule.verification && capsule.verification.length > 0) { capsule.verification.pop(); trimmed = true; }
    if (!trimmed && capsule.workflow && capsule.workflow.length > 0) { capsule.workflow.pop(); trimmed = true; }
    if (!trimmed && capsule.resultSummary) {
      capsule.resultSummary = capsule.resultSummary.slice(0, Math.floor(capsule.resultSummary.length / 2));
      trimmed = true;
    }
    if (!trimmed) break;
    json = JSON.stringify(capsule);
  }

  const h = crypto.createHash('sha256').update(json, 'utf8').digest('hex');
  return { capsule, evidenceHash: 'sha256:' + h, charCount: json.length };
}

module.exports = {
  CAPSULE_LIMITS,
  EVENT_CATEGORY_ALLOWLIST,
  buildEvidenceCapsule,
  // Exported for testing
  _isShadowOrTempPath,
  _isAbsolutePath,
  _stripSecrets,
  _sanitiseToolEvent,
};