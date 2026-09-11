'use strict';

/*
 * trigger-policy.js
 *
 * Pure functions implementing the Learning L0 trigger policy:
 *   - Count meaningful tool iterations
 *   - Threshold check (default 10, matching Hermes 0.19.0 creation_nudge_interval)
 *   - Cooldown / single-flight lock
 *   - Idempotency gate (evidence hash)
 *   - Stable task gate (only success, only agent/office mode)
 *
 * VS Code agnostic — works with plain objects.
 */

const crypto = require('node:crypto');

const CONFIG_DEFAULTS = {
  enabled: true,
  creationNudgeInterval: 10,
  minInterval: 5,
  maxInterval: 100,
};

/**
 * Normalize and clamp the interval value.
 * @param {number} raw
 * @returns {number}
 */
function clampInterval(raw) {
  const n = Number.isFinite(raw) ? Math.round(raw) : CONFIG_DEFAULTS.creationNudgeInterval;
  return Math.max(CONFIG_DEFAULTS.minInterval, Math.min(CONFIG_DEFAULTS.maxInterval, n));
}

/**
 * Check if a tool iteration event is "meaningful".
 * Only counts successful search/read, edit/write, command/tool, verify/test events.
 * Excludes pure chat, progress messages, permission dialogs, and failed retries.
 *
 * @param {{ category: string, status: string }} event
 * @returns {boolean}
 */
function isMeaningfulToolIteration(event) {
  if (!event || typeof event !== 'object') return false;
  const cat = String(event.category || '').toLowerCase();
  const status = String(event.status || '').toLowerCase();
  if (status !== 'done' && status !== 'success' && status !== 'passed') return false;
  const meaningful = new Set(['search', 'read', 'edit', 'write', 'command', 'tool', 'verify', 'test']);
  return meaningful.has(cat);
}

/**
 * Count meaningful tool iterations from a structured event list.
 * @param {Array<{ category: string, status: string }>} events
 * @returns {number}
 */
function countMeaningfulIterations(events) {
  if (!Array.isArray(events)) return 0;
  let count = 0;
  for (const e of events) {
    if (isMeaningfulToolIteration(e)) count++;
  }
  return count;
}

/**
 * Check if the turn is eligible for implicit review.
 *
 * @param {object} params
 * @param {string} params.status - 'success' | 'error' | 'stopped' | 'interrupted'
 * @param {string} params.mode - 'agent' | 'office' | 'chat' | 'plan'
 * @param {string} params.resultText - final assistant text
 * @param {boolean} params.interrupted - was the turn interrupted
 * @param {boolean} params.hasPendingReview - unresolved shadow review exists
 * @returns {boolean}
 */
function isStableTaskTurn({ status, mode, resultText, interrupted, hasPendingReview }) {
  if (status !== 'success') return false;
  if (mode !== 'agent' && mode !== 'office') return false;
  if (!resultText || String(resultText).trim().length === 0) return false;
  if (interrupted) return false;
  if (hasPendingReview) return false;
  return true;
}

/**
 * Compute evidence hash with SHA-256.
 * @param {string} normalizedJson
 * @returns {string}
 */
function computeEvidenceHash(normalizedJson) {
  return 'sha256:' + crypto.createHash('sha256').update(normalizedJson, 'utf8').digest('hex');
}

/**
 * Stable reasonCode constants. Every checkTrigger / checkExplicitLearn branch
 * returns one of these — control flow in the orchestrator/candidate-controller
 * compares reasonCode only, never the natural-language `reason` text.
 *
 * 05_LEARNING_L2_MEMORY_CONTEXT_AND_PROPOSALS §4 (Phase A6).
 */
const REASON_CODES = Object.freeze({
  TRIGGERED: 'TRIGGERED',
  DISABLED: 'DISABLED',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  SINGLE_FLIGHT: 'SINGLE_FLIGHT',
  HASH_PROCESSED: 'HASH_PROCESSED',
  STABILITY_GATE: 'STABILITY_GATE',
  EXPLICIT_OK: 'EXPLICIT_OK',
  EXPLICIT_WRONG_MODE: 'EXPLICIT_WRONG_MODE',
  EXPLICIT_AGENT_RUNNING: 'EXPLICIT_AGENT_RUNNING',
  EXPLICIT_REVIEW_PENDING: 'EXPLICIT_REVIEW_PENDING',
  EXPLICIT_HASH_PROCESSED: 'EXPLICIT_HASH_PROCESSED',
});

/**
 * Trigger policy main check.
 *
 * Returns { triggered: boolean, reasonCode: string, reason?: string }.
 * The natural-language `reason` is for logs only; the controller compares
 * reasonCode, never reason text.
 *
 * @param {object} params
 * @param {number} params.meaningfulIterations - count since last successful skill proposal
 * @param {number} params.creationNudgeInterval - threshold (default 10)
 * @param {boolean} params.enabled - config enabled flag
 * @param {string} params.evidenceHash - SHA-256 of the evidence capsule
 * @param {Set<string>|Array<string>} params.processedHashes - previously processed evidence hashes
 * @param {boolean} params.learningRunActive - is a learning run currently in progress
 * @returns {{ triggered: boolean, reasonCode: string, reason?: string }}
 */
function checkTrigger({ meaningfulIterations, creationNudgeInterval, enabled, evidenceHash, processedHashes, learningRunActive }) {
  if (!enabled) {
    return {
      triggered: false,
      reasonCode: REASON_CODES.DISABLED,
      reason: 'learning.backgroundReview.enabled is false',
    };
  }
  const threshold = clampInterval(creationNudgeInterval);
  if (meaningfulIterations < threshold) {
    return {
      triggered: false,
      reasonCode: REASON_CODES.BELOW_THRESHOLD,
      reason: `meaningful iterations ${meaningfulIterations} < threshold ${threshold}`,
    };
  }
  if (learningRunActive) {
    return {
      triggered: false,
      reasonCode: REASON_CODES.SINGLE_FLIGHT,
      reason: 'learning run already active (single-flight lock)',
    };
  }
  const hashes = processedHashes instanceof Set ? processedHashes : new Set(processedHashes || []);
  if (hashes.has(evidenceHash)) {
    return {
      triggered: false,
      reasonCode: REASON_CODES.HASH_PROCESSED,
      reason: 'evidence already processed (idempotency gate)',
    };
  }
  return { triggered: true, reasonCode: REASON_CODES.TRIGGERED };
}

/**
 * Check if explicit /learn is allowed (bypasses threshold but not safety gates).
 * Returns { allowed, reasonCode, reason? } with stable reasonCode.
 *
 * @param {object} params
 * @param {string} params.mode - current mode
 * @param {boolean} params.agentRunning - is a normal agent request running
 * @param {boolean} params.hasPendingReview - unresolved shadow review
 * @param {string} params.evidenceHash
 * @param {Set<string>|Array<string>} params.processedHashes
 * @returns {{ allowed: boolean, reasonCode: string, reason?: string }}
 */
function checkExplicitLearn({ mode, agentRunning, hasPendingReview, evidenceHash, processedHashes }) {
  if (mode !== 'agent' && mode !== 'office') {
    return {
      allowed: false,
      reasonCode: REASON_CODES.EXPLICIT_WRONG_MODE,
      reason: '/learn only allowed in Agent or Office mode',
    };
  }
  if (agentRunning) {
    return {
      allowed: false,
      reasonCode: REASON_CODES.EXPLICIT_AGENT_RUNNING,
      reason: 'An agent request is already running. Stop first.',
    };
  }
  if (hasPendingReview) {
    return {
      allowed: false,
      reasonCode: REASON_CODES.EXPLICIT_REVIEW_PENDING,
      reason: 'Review is still pending. Resolve before /learn.',
    };
  }
  const hashes = processedHashes instanceof Set ? processedHashes : new Set(processedHashes || []);
  if (hashes.has(evidenceHash)) {
    return {
      allowed: false,
      reasonCode: REASON_CODES.EXPLICIT_HASH_PROCESSED,
      reason: 'evidence already processed (idempotency gate)',
    };
  }
  return { allowed: true, reasonCode: REASON_CODES.EXPLICIT_OK };
}

module.exports = {
  CONFIG_DEFAULTS,
  REASON_CODES,
  clampInterval,
  isMeaningfulToolIteration,
  countMeaningfulIterations,
  isStableTaskTurn,
  computeEvidenceHash,
  checkTrigger,
  checkExplicitLearn,
};