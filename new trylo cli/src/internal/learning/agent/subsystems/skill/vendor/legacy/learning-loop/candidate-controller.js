'use strict';

/*
 * candidate-controller.js
 *
 * Single narrow production controller for the Learning L1 candidate flow.
 * Every code path — immediate finalize, deferred review resolution, replay,
 * reload, duplicate message — funnels through here so that:
 *
 *   1. iteration cadence is applied EXACTLY ONCE per source turn,
 *   2. the candidate policy always sees the cumulative value INCLUDING
 *      this turn's increment,
 *   3. none/suggest/off still preserve the cadence that was just applied,
 *   4. a same-hash replay cannot double-count.
 *
 * Replaces the scattered logic that previously lived in
 * finalizeSuccessfulTurnForLearning + triggerDeferredLearningReview +
 * runImplicitReview. Pure decision + thin persistence; no LLM, no Skill
 * similarity search.
 *
 * 05_LEARNING_L2_MEMORY_CONTEXT_AND_PROPOSALS §4 (Phase A1, A2, A3, A5, A6).
 */

const triggerPolicy = require('./trigger-policy');
const candidatePolicy = require('./candidate-policy');
const learningState = require('./learning-state');

/**
 * Compute the meaningful iteration increment for a turn's events.
 * Pure; the raw-event filter and the persisted-event filter both produce
 * stable-id-bearing events at this point.
 */
function computeIterationIncrement(events) {
  return triggerPolicy.countMeaningfulIterations(events);
}

/**
 * True when a previous run already credited this source turn with its
 * iteration increment. The flag lives on turn.learning.iterationsApplied.
 */
function hasIterationsApplied(turn) {
  if (!turn || typeof turn !== 'object') return false;
  const ls = turn.learning;
  return Boolean(ls && ls.iterationsApplied === true);
}

/**
 * Mark the source turn as having been credited. Idempotent.
 */
function markIterationsApplied(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  learningState.setTurnLearningState(turn, { iterationsApplied: true });
  return turn;
}

/**
 * Locate a turn in the in-memory session cache by precise
 * (sessionId, turnId). Read-only — caller is responsible for mutation
 * through the existing production helper (mutateSessionTurnById).
 */
function findTurnInCache(sessionCache, sessionId, turnId) {
  if (!Array.isArray(sessionCache) || !sessionId || !turnId) return null;
  const session = sessionCache.find(s => s && s.id === sessionId);
  if (!session || !Array.isArray(session.turns)) return null;
  return session.turns.find(t => t && t.id === turnId) || null;
}

/**
 * Read the current learning state from a source turn, or null.
 */
function readTurnLearning(sessionCache, sessionId, turnId) {
  const turn = findTurnInCache(sessionCache, sessionId, turnId);
  if (!turn) return null;
  return turn.learning || null;
}

/**
 * Apply the iteration cadence for a source turn exactly once.
 *
 * Returns the cumulative iteration count AFTER the increment was applied
 * (or the unchanged cumulative value if this turn was already credited).
 *
 * The caller is expected to provide the source turn object. We mutate the
 * turn's learning state in place to set iterationsApplied=true so that
 * subsequent replay/reload from session JSON cannot double-count.
 *
 * 07 §2 A4: if a save subsequently fails, the caller MUST call
 * `unmarkIterationsApplied(turn)` to roll back the mark so the next run
 * can retry the credit. Otherwise the turn would be marked while the
 * globalState increment was lost.
 */
function applyIterationsOnce({ state, workspaceRoot, turn, events }) {
  if (!state || typeof state !== 'object') {
    throw new Error('applyIterationsOnce: state is required');
  }
  const wsRoot = workspaceRoot || '';
  if (hasIterationsApplied(turn)) {
    return {
      cumulativeIterations: learningState.getIterations(state, wsRoot),
      appliedNow: false,
    };
  }
  const increment = computeIterationIncrement(events);
  const cumulative = learningState.addIterations(state, wsRoot, increment);
  markIterationsApplied(turn);
  return {
    cumulativeIterations: cumulative,
    appliedNow: true,
    increment,
  };
}

/**
 * 07 §2 A4: roll back the iterationsApplied mark on a turn. Use this
 * when the caller catches a save failure so the next attempt can
 * re-credit the increment instead of silently losing it.
 */
function unmarkIterationsApplied(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  if (turn.learning && turn.learning.iterationsApplied) {
    turn.learning = Object.assign({}, turn.learning, { iterationsApplied: false });
  }
  return turn;
}

/**
 * Normalise a reviewResolution into a stable {accepted, rejected, settled}
 * object. The controller is the only place this normalisation happens so
 * that the previous turn's resolution cannot leak in.
 */
function normaliseReviewResolution(reviewResolution) {
  if (!reviewResolution || typeof reviewResolution !== 'object') {
    return { accepted: 0, rejected: 0, settled: true };
  }
  return {
    accepted: Math.max(0, Number(reviewResolution.accepted) || 0),
    rejected: Math.max(0, Number(reviewResolution.rejected) || 0),
    settled: reviewResolution.settled !== false,
  };
}

/**
 * Canonical controller entry point. Called by:
 *   - finalizeSuccessfulTurnForLearning (immediate path after assistant text)
 *   - triggerDeferredLearningReview (after review settled)
 *   - replay / reload / duplicate finalize (idempotent)
 *
 * The controller NEVER calls the LLM, NEVER mutates the session array
 * directly (extension helper does that), and NEVER runs the orchestrator —
 * it just decides what the extension should do next.
 *
 * @param {object} params
 * @param {object} params.context - VS Code extension context (for globalState)
 * @param {string} params.workspaceRoot
 * @param {string} params.sessionId
 * @param {string} params.turnId
 * @param {string} params.mode - 'agent' | 'office'
 * @param {Array} [params.events] - persisted meaningful events
 * @param {object} [params.reviewResolution] - { accepted, rejected, settled }
 * @param {string} [params.backgroundMode] - 'auto' | 'suggest' | 'off'
 * @param {number} [params.creationNudgeInterval] - cadence threshold
 * @param {Array} [params.sessionCache] - globalSessionsCache for idempotency
 * @returns {Promise<{
 *   decision: { eligible: boolean, action: 'none'|'suggest'|'auto',
 *               reasonCodes: string[], exclusionCodes: string[] },
 *   cumulativeIterations: number,
 *   iterationsAlreadyApplied: boolean,
 *   appliedNow: boolean,
 *   increment: number,
 *   reviewResolution: { accepted: number, rejected: number, settled: boolean },
 * }>}
 */
async function evaluateCandidateOnce(params) {
  const {
    context, workspaceRoot, sessionId, turnId, mode,
    events, reviewResolution, backgroundMode, creationNudgeInterval,
    sessionCache,
  } = params || {};

  if (!sessionId || !turnId) {
    throw new Error('evaluateCandidateOnce: sessionId and turnId are required');
  }
  if (mode !== 'agent' && mode !== 'office') {
    throw new Error(`evaluateCandidateOnce: invalid mode ${mode}`);
  }

  const state = learningState.loadState(context && context.globalState);
  const wsRoot = workspaceRoot || '';

  // Locate the turn in the cache so we can read/write the idempotency mark.
  const turn = findTurnInCache(sessionCache, sessionId, turnId);
  if (!turn) {
    // Source turn is gone — caller must have already verified; we still
    // return a clean ineligible decision with reason GONE_TURN so the
    // extension can log and stop.
    return {
      decision: {
        eligible: false,
        action: 'none',
        reasonCodes: [],
        exclusionCodes: ['GONE_TURN'],
      },
      cumulativeIterations: learningState.getIterations(state, wsRoot),
      iterationsAlreadyApplied: false,
      appliedNow: false,
      increment: 0,
      reviewResolution: normaliseReviewResolution(reviewResolution),
    };
  }

  // 1. Apply iteration cadence exactly once.
  const applyResult = applyIterationsOnce({
    state,
    workspaceRoot: wsRoot,
    turn,
    events: events || [],
  });
  if (applyResult.appliedNow) {
    try {
      await learningState.saveState(context && context.globalState, state);
    } catch (saveErr) {
      // 07 §2 A4: roll back the mark so a safe retry can re-credit.
      // This keeps the source turn state and the globalState cumulative
      // consistent across the contract.
      unmarkIterationsApplied(turn);
      throw saveErr;
    }
  }

  // 2. Normalise reviewResolution; never read a global.
  const rr = normaliseReviewResolution(reviewResolution);

  // 3. Ask the policy for the decision.
  const decision = candidatePolicy.evaluateCandidate({
    mode,
    turnStatus: turn.status === 'success' ? 'success' : (turn.status || 'success'),
    interrupted: false,
    resultText: String(turn.resultText || ''),
    events: events || [],
    reviewResolution: rr,
    accumulatedIterations: applyResult.cumulativeIterations,
    creationNudgeInterval: Number.isFinite(creationNudgeInterval)
      ? creationNudgeInterval : 10,
    backgroundMode: backgroundMode || 'auto',
    evidenceHashStaged: false,
  });

  return {
    decision,
    cumulativeIterations: applyResult.cumulativeIterations,
    iterationsAlreadyApplied: !applyResult.appliedNow,
    appliedNow: applyResult.appliedNow,
    increment: applyResult.increment || 0,
    reviewResolution: rr,
  };
}

module.exports = {
  computeIterationIncrement,
  hasIterationsApplied,
  markIterationsApplied,
  unmarkIterationsApplied,
  findTurnInCache,
  readTurnLearning,
  applyIterationsOnce,
  normaliseReviewResolution,
  evaluateCandidateOnce,
};
