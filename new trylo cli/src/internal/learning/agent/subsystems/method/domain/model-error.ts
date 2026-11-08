/** Canonical method-review failure contract. Unavailability before transport
 * lets the scheduler consider another source without buying another attempt. */
export class ExperienceModelError extends Error {
  constructor(readonly reason: string, readonly disposition: "unavailable" | "failed" | "cancelled" = "failed") {
    super(reason);
  }
}
