import assert from "node:assert/strict";
import test from "node:test";
import { classifySandboxOutcome, runFakeSandbox } from "../../../../../../tooling/sandbox/fake-executor.js";
import { enforceOutputBounds, validateManifest } from "../../../../../../tooling/package-spi/manifest.js";
import { archive, manifest, passingSignals, pkg } from "../../../../../../tooling/testing/fixtures.js";
import { attachVerification, runValidationPipeline } from "./pipeline.js";

test("failed health probe fails sandbox smoke", () => {
  const result = runValidationPipeline({
    validationId: "v-health",
    pkg: pkg(),
    archive: archive(),
    compressedBytes: 32,
    actor: "verifier",
    signals: passingSignals({ healthPass: false }),
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.verdict, "fail");
    assert.equal(
      result.value.stages.find((item) => item.stage === "sandbox_smoke")?.passed,
      false,
    );
  }
});

test("cancel timeout and crash are never classified success", () => {
  assert.equal(classifySandboxOutcome("cancel"), "cancelled");
  assert.equal(classifySandboxOutcome("timeout"), "timeout");
  assert.equal(classifySandboxOutcome("crash"), "unknown");
  const cancelled = runFakeSandbox({
    outcome: "cancel",
    permissionDenied: true,
    maliciousInput: true,
    repeatCall: false,
  });

  assert.equal(cancelled.ok, true);

  if (cancelled.ok) {
    assert.notEqual(cancelled.value.classified, "ok");
  }
});

test("package SPI requires cancel timeout idempotency and output bounds", () => {
  const valid = validateManifest(manifest());
  assert.equal(valid.ok, true);
  const noTimeout = validateManifest(manifest({ timeoutMs: 0 }));
  assert.equal(noTimeout.ok, false);
});

test("generator cannot write verifier pass", () => {
  const result = runValidationPipeline({
    validationId: "v1",
    pkg: pkg(),
    archive: archive(),
    compressedBytes: 32,
    actor: "generator",
    signals: passingSignals(),
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "generator_cannot_write_verdict");
  }
});

test("validation cannot skip stages", () => {
  const result = runValidationPipeline({
    validationId: "v1",
    pkg: pkg(),
    archive: archive(),
    compressedBytes: 32,
    actor: "verifier",
    signals: passingSignals(),
    stageAttempt: "independent_verdict",
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "stage_order_violation");
  }
});

test("failed verification stays out of production-ready catalog state", () => {
  const result = runValidationPipeline({
    validationId: "v-fail",
    pkg: pkg(),
    archive: archive(),
    compressedBytes: 32,
    actor: "verifier",
    signals: passingSignals({ unitTestsPass: false }),
  });

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.verdict, "fail");
  const next = attachVerification(pkg(), result.value);

  assert.equal(next.ok, true);

  if (!next.ok) {
    return;
  }

  assert.equal(next.value.catalogState, "rejected");
  assert.equal(next.value.verificationRef, "v-fail");
});

test("independent pass attaches verified without exposing capability on fail path", () => {
  const result = runValidationPipeline({
    validationId: "v-pass",
    pkg: pkg(),
    archive: archive(),
    compressedBytes: 32,
    actor: "verifier",
    signals: passingSignals(),
  });

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.verdict, "pass");
  assert.equal(result.value.stages.length, 10);
  const next = attachVerification(pkg(), result.value);

  assert.equal(next.ok, true);

  if (!next.ok) {
    return;
  }

  assert.equal(next.value.catalogState, "verified");
});

test("output bounds truncate/reject overflow and secret leaks", () => {
  const man = manifest({ stdoutBytes: 8, stderrBytes: 8, resultChars: 8 });
  assert.equal(enforceOutputBounds(man, { stdout: "abcdefghijk", stderr: "", result: "ok" }).ok, false);
  assert.equal(enforceOutputBounds(man, { stdout: "", stderr: "", result: "AKIASECRET" }).ok, false);
});
