import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import {
  VALIDATION_STAGE_ORDER,
  type StageResult,
  type ToolPackageVersion,
  type ValidationActor,
  type ValidationRecord,
  type ValidationStageName,
} from "../../../../../../tooling/contract/types.js";
import { transitionCatalog } from "../../../../../../tooling/catalog/lifecycle.js";
import { validateManifest } from "../../../../../../tooling/package-spi/manifest.js";
import { inspectArchive, type ArchiveFixture } from "../quarantine/archive-guard.js";
import type { FakeSandboxReport } from "../../../../../../tooling/sandbox/fake-executor.js";

export type FakeValidationSignals = {
  readonly suspiciousApi: boolean;
  readonly unitTestsPass: boolean;
  readonly sandboxSmokePass: boolean;
  readonly permissionDenialHonored: boolean;
  readonly maliciousInputRejected: boolean;
  readonly cancelWorks: boolean;
  readonly timeoutWorks: boolean;
  readonly crashClassifiedUnknown: boolean;
  readonly idempotent: boolean;
  readonly baselineRegressionPass: boolean;
  readonly secretsInTree: boolean;
  readonly healthPass: boolean;
};

export type PipelineInput = {
  readonly validationId: string;
  readonly pkg: ToolPackageVersion;
  readonly archive: ArchiveFixture;
  readonly compressedBytes: number;
  readonly actor: ValidationActor;
  readonly signals: FakeValidationSignals;
  readonly sandbox?: FakeSandboxReport;
  readonly stageAttempt?: ValidationStageName;
};

export type PipelineFailure =
  | "generator_cannot_write_verdict"
  | "stage_order_violation"
  | "validation_failed";

function stage(
  name: ValidationStageName,
  passed: boolean,
  detail: string,
): StageResult {
  return { stage: name, passed, detail };
}

export function runValidationPipeline(
  input: PipelineInput,
): Result<ValidationRecord, PipelineFailure> {
  if (input.actor === "generator") {
    return err("generator_cannot_write_verdict", "generator cannot write verifier pass");
  }

  if (input.stageAttempt !== undefined) {
    const expected = VALIDATION_STAGE_ORDER[0];
    if (input.stageAttempt !== expected) {
      const index = VALIDATION_STAGE_ORDER.indexOf(input.stageAttempt);
      if (index !== 0) {
        return err("stage_order_violation", "validation stages cannot be skipped or reordered");
      }
    }
  }

  const stages: StageResult[] = [];
  const provenanceOk =
    input.pkg.provenance.sourceUrl.length > 0 &&
    input.pkg.licenseSpdx !== "UNKNOWN" &&
    input.pkg.licenseSpdx !== "UNLICENSED" &&
    (input.pkg.origin !== "optimized" ||
      (input.pkg.provenance.parentVersionId !== undefined && input.pkg.provenance.upstreamUrl.length > 0));

  stages.push(
    stage(
      "source_license_provenance",
      provenanceOk,
      provenanceOk ? "provenance complete" : "missing source/license/upstream",
    ),
  );
  const archive = inspectArchive(input.archive, input.compressedBytes);
  const manifest = validateManifest(input.pkg.manifest);
  const archiveOk = archive.ok && manifest.ok;

  stages.push(
    stage(
      "archive_path_manifest_schema",
      archiveOk,
      archiveOk ? "archive and manifest accepted" : "archive or manifest rejected",
    ),
  );
  const staticOk = !input.signals.suspiciousApi && !input.signals.secretsInTree;

  stages.push(
    stage(
      "static_secret_malware_api",
      staticOk,
      staticOk ? "static scan clean" : "secret or suspicious API",
    ),
  );
  stages.push(
    stage(
      "type_build_unit",
      input.signals.unitTestsPass,
      input.signals.unitTestsPass ? "unit tests pass" : "unit tests failed",
    ),
  );
  const sandbox = input.sandbox;
  const healthOk = input.pkg.manifest.healthProbe !== true || input.signals.healthPass;
  const smokePass =
    (sandbox !== undefined ? sandbox.classified === "ok" : input.signals.sandboxSmokePass) && healthOk;

  stages.push(
    stage(
      "sandbox_smoke",
      smokePass,
      smokePass ? "sandbox smoke pass" : "sandbox smoke failed",
    ),
  );
  const permOk =
    sandbox !== undefined
      ? sandbox.permissionDenialHonored && sandbox.maliciousInputRejected
      : input.signals.permissionDenialHonored && input.signals.maliciousInputRejected;

  stages.push(
    stage(
      "permission_malicious_bounds",
      permOk,
      permOk ? "permission and bounds honored" : "permission or malicious input failed",
    ),
  );
  const cancelOk =
    sandbox !== undefined
      ? sandbox.crashClassifiedUnknown && sandbox.classified !== "failed"
      : input.signals.cancelWorks && input.signals.timeoutWorks && input.signals.crashClassifiedUnknown;

  stages.push(
    stage(
      "cancel_timeout_crash",
      cancelOk,
      cancelOk ? "cancel/timeout/unknown classified" : "lifecycle outcomes misclassified",
    ),
  );
  stages.push(
    stage(
      "idempotency_side_effects",
      sandbox !== undefined ? sandbox.idempotent : input.signals.idempotent,
      (sandbox !== undefined ? sandbox.idempotent : input.signals.idempotent)
        ? "idempotent"
        : "side effects not idempotent",
    ),
  );
  stages.push(
    stage(
      "baseline_regression",
      input.signals.baselineRegressionPass,
      input.signals.baselineRegressionPass ? "no negative regression" : "negative regression",
    ),
  );
  const priorFailed = stages.some((item) => !item.passed);
  const independentPass = !priorFailed;

  stages.push(
    stage(
      "independent_verdict",
      independentPass,
      independentPass ? "independent verifier pass" : "independent verifier fail",
    ),
  );
  const record: ValidationRecord = {
    validationId: input.validationId,
    packageVersionId: input.pkg.packageVersionId,
    stages,
    verdict: independentPass ? "pass" : "fail",
    actor: "verifier",
  };

  return ok(record);
}

export function attachVerification(
  pkg: ToolPackageVersion,
  record: ValidationRecord,
): Result<ToolPackageVersion, "illegal_catalog_transition"> {
  let current = pkg;
  if (current.catalogState === "quarantined") {
    const verifying = transitionCatalog(current, "verifying");
    if (!verifying.ok) {
      return verifying;
    }
    current = verifying.value;
  }

  if (current.catalogState !== "verifying") {
    return err("illegal_catalog_transition", "verification attaches only from quarantined or verifying");
  }

  const next = transitionCatalog(current, record.verdict === "pass" ? "verified" : "rejected");
  if (!next.ok) {
    return next;
  }

  return ok({ ...next.value, verificationRef: record.validationId });
}
