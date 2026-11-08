import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderRequest } from "../ports/provider.js";
import type { TeamMemberIdentity } from "./team.js";

/** An actual compiled child request received a provider acknowledgement.
 * Request text is transient input to a trusted host observer, never journaled here.
 * Acknowledgement does not establish task success or independent verification.
 */
export type ChildRequestDispatch = {
  readonly request: ProviderRequest;
  readonly taskId: string;
  readonly agentId: string;
  readonly round: number;
  readonly rootAttemptId: string;
  readonly parentToolCallId?: string;
  readonly teamMember?: TeamMemberIdentity;
};

/** The shared executor only delivers facts; host wiring owns their durable projection. */
export type ChildRequestDispatchedObserver = (input: ChildRequestDispatch) => Promise<void>;

/** The host converts matching request facts to safe generic observation payloads. */
export type ChildRequestObservation = (input: ChildRequestDispatch) => Promise<readonly JsonObject[] | undefined>;
