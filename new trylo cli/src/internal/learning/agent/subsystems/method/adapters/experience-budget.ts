/** Method-owned engineering limits; the shared Board remains the only spending authority. */
export const EXPERIENCE_MODEL_LIMITS = Object.freeze({
  scopeCalls: 4,
  scopeTokens: 24000,
  scopeSteps: 4,
  promptChars: 12000,
  reservationTokens: 12000,
  outputTokens: 1500,
  timeoutMs: 30000,
  claimLeaseMs: 120000,
});
