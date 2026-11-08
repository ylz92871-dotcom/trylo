import { permissionPattern } from "../../ports/permission.js";
import type {
  EscalationAuthority,
  EscalationInput,
  EscalationOutcome,
  EscalationTicket,
} from "../../domain/sandbox-escalation.js";

/**
 * The one person-facing escalation, and the owner of the tickets it issues
 * (C65).
 *
 * Two properties are the whole design:
 *
 *  - There is no "remember" answer. Every other prompt in this CLI can be told
 *    to remember, because repeating a call is harmless; here the thing being
 *    released is a boundary, and a remembered boundary release is just a
 *    disabled sandbox. The prompt therefore offers yes/no/cancel and nothing
 *    else.
 *  - The ticket is a reference. What was released, for which call, with which
 *    arguments is kept here and read back through `redeem`, which spends it in
 *    the same call. A caller that invents a ticket id gets nothing, because
 *    nothing here was ever written under it.
 */

export type EscalationIo = {
  /** Writes the prompt to stderr so stdout stays a pure protocol stream. */
  readonly prompt: (text: string) => void;
  /** Reads one line; `undefined` means the input ended. */
  readonly readLine: () => Promise<string | undefined>;
};

type IssuedRelease = {
  readonly toolCallId: string;
  readonly code: string;
  readonly fingerprint: string;
};

function fingerprintOf(input: EscalationInput): string {
  return permissionPattern(input.name, input.arguments);
}

/**
 * The refusal and the exact call, so the answer is given about something
 * concrete. A prompt that named only the tool would be answered about the wrong
 * thing: the same tool is fine for most paths and refused for this one.
 */
function describeRefusal(input: EscalationInput): string {
  const call = Object.entries(input.arguments)
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return [
    `sandbox refused this call (${input.code}) and is asking whether to release it once`,
    `  refusal: ${input.message}`,
    `  call: ${input.name}(${call}) (${input.toolCallId})`,
    "  this releases this exact call only; nothing is remembered and the boundary still applies to every other call",
  ].join("\n");
}

const PROMPT = "release this call anyway? [y]once [n]refuse [c]cancel: ";

const CANCELLED: EscalationOutcome = { ok: false, reason: "cancelled", message: "input_closed" };
const REFUSED: EscalationOutcome = { ok: false, reason: "denied", message: "user_denied" };

export function createInteractiveEscalation(io: EscalationIo): EscalationAuthority {
  const issued = new Map<string, IssuedRelease>();
  let counter = 0;

  return {
    async request(input: EscalationInput): Promise<EscalationOutcome> {
      io.prompt(`${describeRefusal(input)}\n${PROMPT}`);
      const answer = await io.readLine();
      if (answer === undefined) {
        return CANCELLED;
      }

      const normalized = answer.trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") {
        counter += 1;
        const ticketId = `escalate-${counter}`;

        issued.set(ticketId, {
          toolCallId: input.toolCallId,
          code: input.code,
          fingerprint: fingerprintOf(input),
        });

        return { ok: true, ticket: { ticketId } };
      }

      if (normalized === "c" || normalized === "cancel") {
        return CANCELLED;
      }

      return REFUSED;
    },

    redeem(ticket: EscalationTicket | undefined, input: EscalationInput): boolean {
      if (ticket === undefined) {
        return false;
      }

      const release = issued.get(ticket.ticketId);

      issued.delete(ticket.ticketId);

      if (release === undefined) {
        return false;
      }

      return (
        release.toolCallId === input.toolCallId &&
        release.code === input.code &&
        release.fingerprint === fingerprintOf(input)
      );
    },
  };
}
