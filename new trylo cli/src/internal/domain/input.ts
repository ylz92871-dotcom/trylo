import type { JsonObject } from "../protocol/envelope.js";
import type { VerificationStatus } from "../contract/execution.js";

type Base = {
  readonly eventId: string;
  /** Dense dispatch position owned by the execution journal; absent in legacy journals. */
  readonly deliverySequence?: number;
};

/** Optional failure detail; it changes no approval or execution authority. */
export type PermissionRefusalDetails = {
  readonly code?: "invalid_arguments";
  readonly message?: string;
};

export type ReduceInput =
  | (Base & {
      readonly type: "start_turn";
      readonly sessionId: string;
      readonly turnId: string;
      readonly correlationId: string;
      readonly text: string;
    })
  | (Base & { readonly type: "begin_stream" })
  | (Base & { readonly type: "text_delta"; readonly text: string })
  | (Base & {
      readonly type: "reasoning_delta";
      readonly text: string;
      readonly redacted: boolean;
    })
  | (Base & {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly reasoningTokens?: number;
      readonly totalTokens?: number;
    })
  | (Base & {
      readonly type: "tool_request";
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
      readonly needsApproval: boolean;
      /**
       * Loop-supplied, like `needsApproval`: when true this call joins the
       * in-flight batch instead of becoming the single active call. Absent means
       * the historical single-tool shape, byte for byte.
       */
      readonly batch?: boolean;
    })
  | (Base & { readonly type: "tool_input_opened"; readonly toolCallId: string })
  | (Base & {
      readonly type: "tool_arguments_invalid";
      readonly toolCallId: string;
      readonly name: string;
      readonly message: string;
    })
  /**
   * The sandbox refused the call before anyone was asked to approve it. It is
   * its own input rather than a permission outcome: permission answers "may it
   * run" and the sandbox answers "can it be asked at all", and collapsing the
   * two would let a later stage appear to grant what an earlier one forbade.
   */
  | (Base & {
      readonly type: "tool_rejected";
      readonly toolCallId: string;
      readonly code: string;
      readonly message: string;
    })
  | (Base & {
      readonly type: "finish";
      /** Unified provider finish reason, absent when the stream just stopped. */
      readonly reason?: string;
      /** Provider contract demands another request even with no tool results. */
      readonly requiresFollowUp?: boolean;
    })
  /**
   * The turn loop, not the provider, ends the turn. `finish` only closes one
   * stream; these two inputs carry the explicit decision that followed it, so a
   * stream can never quietly be mistaken for a completed turn.
   */
  | (Base & { readonly type: "turn_complete" })
  | (Base & { readonly type: "turn_failed"; readonly reason: string })
  | (Base & { readonly type: "provider_raw_unknown"; readonly wire: string })
  | (Base & { readonly type: "budget_exhausted"; readonly reason: string; readonly used?: number; readonly limit?: number })
  | (Base & {
      readonly type: "transport_fail";
      readonly message: string;
      /** Stable provider error class; drives the CLI exit code, never parsed from text. */
      readonly errorClass?: string;
    })
  | (Base & {
      readonly type: "transport_unknown";
      readonly message: string;
      readonly errorClass?: string;
    })
  /**
   * A message from the person driving the run, arriving while the turn is still
   * in flight (WP D 波 §5.2).
   *
   * `steer` means "take this into account now": the loop promotes it at the next
   * safe boundary and forgives the steps already spent. `queue` means "say this
   * when you are free": one message per gap.
   *
   * The reducer accepts this input **only** in `turning` — the phase where no
   * stream is open and no tool is in flight. Anywhere else it is an illegal
   * transition, which is what makes "a steer is never promoted in the middle of a
   * tool execution" structural rather than a matter of the loop behaving itself.
   */
  | (Base & {
      readonly type: "user_input";
      readonly text: string;
      readonly mode: "steer" | "queue";
    })
  | (Base & { readonly type: "cancel" })
  | (Base & { readonly type: "permission_approved"; readonly toolCallId: string })
  | (Base & PermissionRefusalDetails & { readonly type: "permission_denied"; readonly toolCallId: string })
  | (Base & { readonly type: "permission_expired"; readonly toolCallId: string })
  | (Base & {
      readonly type: "permission_failed";
      readonly toolCallId: string;
      readonly message: string;
    })
  | (Base & {
      readonly type: "tool_succeeded";
      readonly toolCallId: string;
      readonly value: JsonObject;
      /** The same bounded text delivered to the model; absent in older journals. */
      readonly output?: string;
      readonly truncated?: boolean;
    })
  | (Base & { readonly type: "tool_failed"; readonly toolCallId: string; readonly message: string })
  | (Base & { readonly type: "tool_unknown"; readonly toolCallId: string; readonly message: string })
  | (Base & { readonly type: "tool_cancelled"; readonly toolCallId: string })
  | (Base & { readonly type: "retry" })
  | (Base & {
      readonly type: "check_result";
      readonly checkId: string;
      readonly verdict: Exclude<VerificationStatus, "unset">;
    });

export type InputType = ReduceInput["type"];
