import { err, ok, type Result } from "../contract/result.js";

export type FakeSandboxOutcome = "ok" | "cancel" | "timeout" | "crash" | "unknown";

export type ClassifiedSandbox = "ok" | "cancelled" | "timeout" | "unknown" | "failed";

export type FakeSandboxRequest = {
  readonly outcome: FakeSandboxOutcome;
  readonly permissionDenied: boolean;
  readonly maliciousInput: boolean;
  readonly repeatCall: boolean;
};

export type FakeSandboxReport = {
  readonly classified: ClassifiedSandbox;
  readonly permissionDenialHonored: boolean;
  readonly maliciousInputRejected: boolean;
  readonly idempotent: boolean;
  readonly crashClassifiedUnknown: boolean;
};

export function classifySandboxOutcome(outcome: FakeSandboxOutcome): ClassifiedSandbox {
  switch (outcome) {
    case "ok":
      return "ok";
    case "cancel":
      return "cancelled";
    case "timeout":
      return "timeout";
    case "crash":
    case "unknown":
      return "unknown";
  }
}

export function runFakeSandbox(
  request: FakeSandboxRequest,
): Result<FakeSandboxReport, "classified_crash_as_success"> {
  const classified = classifySandboxOutcome(request.outcome);
  if (request.outcome === "crash" && classified === "ok") {
    return err("classified_crash_as_success", "crash must be unknown, never success");
  }

  return ok({
    classified,
    permissionDenialHonored: request.permissionDenied,
    maliciousInputRejected: request.maliciousInput,
    idempotent: request.repeatCall === false,
    crashClassifiedUnknown: request.outcome !== "crash" || classified === "unknown",
  });
}

export function passingSandbox(): FakeSandboxReport {
  return {
    classified: "ok",
    permissionDenialHonored: true,
    maliciousInputRejected: true,
    idempotent: true,
    crashClassifiedUnknown: true,
  };
}
