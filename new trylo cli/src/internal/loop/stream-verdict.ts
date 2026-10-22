import type { ReduceInput } from "../domain/input.js";

/** Only successful provider endings authorize the tentative calls in a stream. */
export function isSuccessfulStreamFinish(reason: string | undefined): boolean {
  return reason === "stop" || reason === "tool_calls";
}

/**
 * Text is already durable, but tools must wait for the whole response's verdict.
 * A later error, cancellation or disconnect invalidates every tentative call,
 * including calls that happened to finish assembling before the failure.
 */
export function executableStreamInputs(inputs: ReadonlyArray<ReduceInput>): ReadonlyArray<ReduceInput> {
  const accepted = inputs.some(input => input.type === "finish" && isSuccessfulStreamFinish(input.reason))
    && !inputs.some(input => input.type === "transport_fail" || input.type === "transport_unknown" || input.type === "cancel");
  if (accepted) return inputs;
  return inputs.filter(input => input.type !== "tool_request"
    && input.type !== "tool_input_opened" && input.type !== "tool_arguments_invalid")
    .map(input => input.type === "finish" ? { ...input, requiresFollowUp: false } : input);
}
