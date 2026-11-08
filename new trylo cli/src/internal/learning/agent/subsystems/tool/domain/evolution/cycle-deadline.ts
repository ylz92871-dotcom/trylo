/** Host-owned dispatch time slice, distinct from a user stop or lost Board claim. */
export const TOOL_CYCLE_DEADLINE = "tool_cycle_deadline";

export function toolCycleDeadlineReached(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === TOOL_CYCLE_DEADLINE;
}
