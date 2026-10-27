export type SessionLifecycle = "open" | "closing" | "closed";

type AdmissionCode = "session_start_cancelled" | "session_registry_closed";
const messages: Readonly<Record<AdmissionCode, string>> = {
  session_start_cancelled: "The command start was cancelled before native dispatch",
  session_registry_closed: "This execution is closing or closed; create a new execution before starting commands",
};

export class ProcessSessionAdmissionError extends Error {
  constructor(readonly code: AdmissionCode) {
    super(`${code}: ${messages[code]}`);
    this.name = "ProcessSessionAdmissionError";
  }
}

/** Check again after any asynchronous preparation, immediately before spawn. */
export function assertSessionStartAllowed(lifecycle: SessionLifecycle, signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProcessSessionAdmissionError("session_start_cancelled");
  if (lifecycle !== "open") throw new ProcessSessionAdmissionError("session_registry_closed");
}
