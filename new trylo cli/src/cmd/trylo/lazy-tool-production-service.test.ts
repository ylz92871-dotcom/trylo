import assert from "node:assert/strict";
import test from "node:test";
import { lazyToolProductionService } from "./lazy-tool-production-service.js";
import type { ToolProductionPort } from "../../internal/ports/tool-production.js";

test("tool capabilities remain visible before one shared lazy load and preserve original failures", async () => {
  const failure = new Error("original_verifier_failure"), reference = { receiptId: "original:receipt" };
  const expected = { domain: "agent_method" as const, subjectKind: "tool_package_version" as const,
    subjectId: "original:tool", subjectVersion: "original:version", scope: "original:scope" };
  let loads = 0, calls = 0, release!: (service: Required<ToolProductionPort>) => void;
  const loaded = new Promise<Required<ToolProductionPort>>(resolve => { release = resolve; });
  const proxy = lazyToolProductionService(() => {
    loads++;
    return loaded;
  });

  for (const capability of [proxy.authority.verify, proxy.check, proxy.execute, proxy.inspectInstallation])
    assert.equal(typeof capability, "function");

  assert.equal(loads, 0);
  const first = proxy.authority.verify(reference, expected), second = proxy.authority.verify(reference, expected);

  assert.equal(loads, 1);
  const unavailable = async (): Promise<never> => { throw failure; };

  release({ authority: { async verify(actualReference, actualExpected) {
    calls++;
    assert.equal(actualReference, reference);
    assert.equal(actualExpected, expected);
    throw failure;
  } }, check: unavailable, execute: unavailable, inspectInstallation: unavailable });
  await assert.rejects(first, error => error === failure);
  await assert.rejects(second, error => error === failure);
  assert.equal(calls, 2);
  assert.equal(loads, 1);
  let failures = 0;
  const rejected = lazyToolProductionService(async () => {
    failures++;
    throw failure;
  });

  await assert.rejects(rejected.authority.verify(reference, expected), error => error === failure);
  await assert.rejects(rejected.authority.verify(reference, expected), error => error === failure);
  assert.equal(failures, 1, "a failed load must not silently retry an actual checker construction");
});
