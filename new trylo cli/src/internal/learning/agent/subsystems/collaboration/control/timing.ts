/** Internal wall-clock policy. These are execution deadlines, never model-token or call allowances. */
export const COLLABORATION_TIMING = Object.freeze({ stepMs: 150_000, ioMs: 30_000, maxWorkMs: 540_000, cleanupMs: 30_000, responseMs: 30_000 });
export const COLLABORATION_WORK_TIMEOUT = "learning_work_timeout";

export function collaborationTimingFor(maxCalls: number) {
  const workMs = Math.min(maxCalls * COLLABORATION_TIMING.stepMs + COLLABORATION_TIMING.ioMs, COLLABORATION_TIMING.maxWorkMs);
  const leaseMs = workMs + COLLABORATION_TIMING.cleanupMs;
  return { stepMs: COLLABORATION_TIMING.stepMs, workMs, leaseMs, toolTimeoutMs: leaseMs + COLLABORATION_TIMING.responseMs };
}
