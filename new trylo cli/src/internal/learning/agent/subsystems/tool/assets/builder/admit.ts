import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolPackageVersion, ValidationRecord } from "../../../../../../tooling/contract/types.js";
import type { ArchiveFixture } from "../quarantine/archive-guard.js";
import { passingSandbox } from "../../../../../../tooling/sandbox/fake-executor.js";
import { attachVerification, runValidationPipeline, type FakeValidationSignals } from "../validation/pipeline.js";

export type AdmitFailure = "validation_failed" | "generator_cannot_write_verdict" | "stage_order_violation";

export function admitBuiltPackage(input: {
  readonly pkg: ToolPackageVersion;
  readonly archive: ArchiveFixture;
  readonly compressedBytes: number;
  readonly signals: FakeValidationSignals;
}): Result<{ readonly pkg: ToolPackageVersion; readonly validation: ValidationRecord }, AdmitFailure> {
  const pipeline = runValidationPipeline({
    validationId: `val:${input.pkg.packageVersionId}`,
    pkg: input.pkg,
    archive: input.archive,
    compressedBytes: input.compressedBytes,
    actor: "verifier",
    signals: input.signals,
    sandbox: passingSandbox(),
  });
  if (!pipeline.ok) {
    return pipeline;
  }

  const admitted = attachVerification(input.pkg, pipeline.value);
  if (!admitted.ok) {
    return err("validation_failed", admitted.message);
  }

  if (pipeline.value.verdict !== "pass") {
    return err("validation_failed", "built package failed the same quarantine verification pipeline");
  }

  return ok({ pkg: admitted.value, validation: pipeline.value });
}
