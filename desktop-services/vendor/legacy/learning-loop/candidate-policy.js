'use strict';

/*
 * candidate-policy.js
 *
 * Deterministic, zero-model-cost candidate evaluation for Learning L1.
 * Pure functions operating on structured facts — no LLM, no Skill similarity
 * search, no natural-language sentiment guessing.
 *
 * 04_LEARNING_L1_CANDIDATE_GOVERNANCE §5.
 */

const EVENT_CATEGORY_ALLOWLIST = new Set([
  'search', 'read', 'edit', 'write', 'command', 'tool', 'verify', 'test',
]);

const EDIT_CATEGORIES = new Set(['edit', 'write']);
const VERIFY_CATEGORIES = new Set(['verify', 'test']);
const ACTIVE_CATEGORIES = new Set(['edit', 'write', 'command']);

/**
 * Count meaningful events by category from a persisted event list.
 * Events must have status='done' and a stable id.
 *
 * @param {Array} events
 * @returns {{ total: number, categories: Set<string>, hasEdit: boolean, hasVerify: boolean, hasRead: boolean, hasCommand: boolean }}
 */
function _analyzeEvents(events) {
  const result = {
    total: 0,
    categories: new Set(),
    hasEdit: false,
    hasVerify: false,
    hasRead: false,
    hasCommand: false,
  };
  if (!Array.isArray(events)) return result;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const cat = String(e.category || '').toLowerCase().trim();
    if (!EVENT_CATEGORY_ALLOWLIST.has(cat)) continue;
    const status = String(e.status || '').toLowerCase();
    if (status !== 'done') continue;
    if (!e.id || typeof e.id !== 'string' || !e.id.trim()) continue;
    result.total++;
    result.categories.add(cat);
    if (EDIT_CATEGORIES.has(cat)) result.hasEdit = true;
    if (VERIFY_CATEGORIES.has(cat)) result.hasVerify = true;
    if (cat === 'read' || cat === 'search') result.hasRead = true;
    if (cat === 'command') result.hasCommand = true;
  }
  return result;
}

/**
 * Evaluate whether a settled turn is a candidate for learning.
 *
 * Input: structured facts only. No prompt/result text is parsed.
 * Output: { eligible, action, reasonCodes, exclusionCodes }
 *
 * action values:
 *   'none'   — not worth learning
 *   'suggest' — medium confidence, show UI hint only, don't call model
 *   'auto'   — high confidence, proceed to L0 orchestrator
 *
 * @param {object} params
 * @param {string} params.mode - 'agent' | 'office' | 'chat' | 'plan'
 * @param {string} params.turnStatus - 'success' | 'error' | 'stopped' | 'interrupted'
 * @param {boolean} params.interrupted
 * @param {string} params.resultText - final assistant text
 * @param {Array} params.events - persisted turn events (status='done', has id)
 * @param {object} [params.reviewResolution] - { accepted, rejected, settled }
 * @param {number} params.accumulatedIterations
 * @param {number} params.creationNudgeInterval
 * @param {string} params.backgroundMode - 'auto' | 'suggest' | 'off'
 * @param {boolean} [params.evidenceHashStaged] - is the evidence hash already staged/processed?
 * @returns {{ eligible: boolean, action: string, reasonCodes: string[], exclusionCodes: string[] }}
 */
function evaluateCandidate({
  mode,
  turnStatus,
  interrupted,
  resultText,
  events,
  reviewResolution,
  accumulatedIterations,
  creationNudgeInterval,
  backgroundMode,
  evidenceHashStaged,
}) {
  const reasonCodes = [];
  const exclusionCodes = [];

  // --- Hard exclusions (§5.1) — any hit → action=none ---

  // mode not agent/office
  if (mode !== 'agent' && mode !== 'office') {
    exclusionCodes.push('INELIGIBLE_MODE');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // status not success, or interrupted, or empty result
  if (turnStatus !== 'success') {
    exclusionCodes.push('TURN_NOT_SUCCESS');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }
  if (interrupted) {
    exclusionCodes.push('INTERRUPTED');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }
  if (!resultText || String(resultText).trim().length === 0) {
    exclusionCodes.push('EMPTY_RESULT');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // review not settled
  if (reviewResolution && !reviewResolution.settled) {
    exclusionCodes.push('REVIEW_PENDING');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // Analyse events ONCE up-front so the hard-exclusion and the high-confidence
  // branches share a single source of truth. (Phase A5 — 05 §4 A5.)
  const analysis = _analyzeEvents(events);

  // all file changes rejected, no independent verification.
  // Use the shared analysis.hasVerify — do NOT write a separate loose
  // events.some(category) check that can be bypassed by a running verify.
  if (reviewResolution && reviewResolution.settled &&
      reviewResolution.accepted === 0 && reviewResolution.rejected > 0 &&
      !analysis.hasVerify) {
    exclusionCodes.push('ALL_REJECTED_NO_VERIFY');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // backgroundReview disabled/off
  if (backgroundMode === 'off') {
    exclusionCodes.push('BACKGROUND_DISABLED');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // evidence hash already staged or processed
  if (evidenceHashStaged) {
    exclusionCodes.push('HASH_ALREADY_STAGED');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // --- Not worth learning (§5.4) — using the analysis already computed above ---
  // Only read/search
  const cadenceReached = accumulatedIterations >= creationNudgeInterval;
  const nonReadCategories = Array.from(analysis.categories).filter(c => c !== 'read' && c !== 'search');
  if (analysis.total === 0 || (nonReadCategories.length === 0 && !analysis.hasVerify)) {
    exclusionCodes.push('ONLY_READ_SEARCH');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // Single simple command, no file changes/verification
  if (analysis.total === 1 && analysis.hasCommand && !analysis.hasEdit && !analysis.hasVerify) {
    exclusionCodes.push('SINGLE_SIMPLE_COMMAND');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // --- High confidence auto candidate (§5.2) ---
  const hasAcceptedFile = reviewResolution && reviewResolution.accepted > 0;

  // At least one edit/write done + at least one verify/test done
  if (analysis.hasEdit && analysis.hasVerify) {
    reasonCodes.push('VERIFIED_CHANGE');
  }
  // At least one accepted file + verify/test done
  if (hasAcceptedFile && analysis.hasVerify) {
    reasonCodes.push('ACCEPTED_AND_VERIFIED');
  }
  // 4+ meaningful events, 2+ categories, includes edit/write/command
  if (analysis.total >= 4 && analysis.categories.size >= 2 &&
      Array.from(analysis.categories).some(c => ACTIVE_CATEGORIES.has(c))) {
    reasonCodes.push('NONTRIVIAL_WORKFLOW');
  }

  if (cadenceReached) {
    reasonCodes.push('CADENCE_REACHED');
  }

  // Determine if any high-confidence signal exists
  const hasHighConfidence = reasonCodes.some(r =>
    r === 'VERIFIED_CHANGE' || r === 'ACCEPTED_AND_VERIFIED' || r === 'NONTRIVIAL_WORKFLOW'
  );

  // --- Medium confidence suggest candidate (§5.3) ---
  // edit without verify
  const hasEditNoVerify = analysis.hasEdit && !analysis.hasVerify;
  // 2-3 meaningful events, at least one not read/search
  const hasModerateWorkflow = analysis.total >= 2 && analysis.total <= 3 &&
    nonReadCategories.length > 0;
  // cadence not reached but has accepted + verified
  const hasAcceptedVerifiedBelowCadence = hasAcceptedFile && analysis.hasVerify && !cadenceReached;

  // --- Final action determination ---

  // If backgroundMode is 'suggest', all auto candidates downgrade to suggest
  if (backgroundMode === 'suggest') {
    if (hasHighConfidence || hasEditNoVerify || hasModerateWorkflow || hasAcceptedVerifiedBelowCadence) {
      return {
        eligible: true,
        action: 'suggest',
        reasonCodes,
        exclusionCodes,
      };
    }
    // If no signal at all, not worth learning
    exclusionCodes.push('NO_LEARNING_SIGNAL');
    return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
  }

  // backgroundMode is 'auto'
  if (hasHighConfidence && cadenceReached) {
    return {
      eligible: true,
      action: 'auto',
      reasonCodes,
      exclusionCodes,
    };
  }

  // High confidence but cadence not reached → suggest (don't auto-call model)
  if (hasHighConfidence && !cadenceReached) {
    return {
      eligible: true,
      action: 'suggest',
      reasonCodes,
      exclusionCodes,
    };
  }

  // Medium confidence signals
  if (hasEditNoVerify || hasModerateWorkflow || hasAcceptedVerifiedBelowCadence) {
    return {
      eligible: true,
      action: 'suggest',
      reasonCodes,
      exclusionCodes,
    };
  }

  // Nothing interesting
  exclusionCodes.push('NO_LEARNING_SIGNAL');
  return { eligible: false, action: 'none', reasonCodes, exclusionCodes };
}

/**
 * Resolve the effective background mode from config.
 * Handles backward compatibility:
 * - enabled=false → 'off'
 * - enabled=true, mode missing → 'auto'
 * - mode present → use mode
 *
 * @param {{ enabled?: boolean, mode?: string }} config
 * @returns {string} 'auto' | 'suggest' | 'off'
 */
function resolveBackgroundMode(config) {
  if (!config) return 'auto';
  const enabled = config.enabled !== false; // default true
  if (!enabled) return 'off';
  const mode = String(config.mode || '').toLowerCase().trim();
  if (mode === 'off' || mode === 'suggest' || mode === 'auto') return mode;
  return 'auto'; // default
}

module.exports = {
  evaluateCandidate,
  resolveBackgroundMode,
  EVENT_CATEGORY_ALLOWLIST,
};
