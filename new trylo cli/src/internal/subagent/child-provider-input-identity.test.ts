import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ProviderContinuationPort, ProviderNativeRequestIdentity, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { measureNativeRequestIdentity } from "../loop/prompt-measurement.js";
import { createChildProviderSession } from "./child-provider-session.js";

const signal = new AbortController().signal;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const request = (scope: string): ProviderRequest => ({ model: "local-child-native", attemptId: "attempt:" + scope,
  continuationScope: scope, tools: [], messages: [{ role: "assistant", content: "Recorded public answer." }] });

function fixture(supportsMeasure = true) {
  const measurements: ProviderRequest[] = [], sends: ProviderRequest[] = [];
  let captures = 0, restores = 0, forks = 0;
  const identityFor = (input: ProviderRequest): ProviderNativeRequestIdentity => ({
    requestDigest: digest(["local-transport", input.model, input.continuationScope]),
    messageFieldDigests: input.messages.map(message => digest([message.role, input.continuationScope, "scripted-native-fields"])),
    messageOverheadTokens: input.messages.map(() => 17),
  });
  const native: ProviderContinuationPort = {
    capture() {
      captures++;
      return undefined;
    }, restore() { restores++; },
    ...(supportsMeasure ? { measureRequestIdentity: (input: ProviderRequest) => {
      measurements.push(input);
      return identityFor(input);
    } } : {}),
  };
  const child: ProviderPort = { continuation: native, async *stream(input) {
    sends.push(input);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const parent: ProviderPort = { fork() {
    forks++;
    return child;
  },
    continuation: { capture() { throw new Error("parent capture must remain isolated"); }, restore() { throw new Error("parent restore must remain isolated"); },
      measureRequestIdentity() { throw new Error("parent native identity is not the child transport"); } },
    async *stream() { throw new Error("parent stream must remain isolated"); },
  };
  const session = createChildProviderSession(parent);

  return { session, measurements, sends, identityFor, counts: () => ({ captures, restores, forks }) };
}

test("measuring a fresh child uses fork-owned native fields without locking its task scope", async () => {
  const f = fixture(), a = request("scope:A"), b = request("scope:B");

  assert.deepEqual(measureNativeRequestIdentity(f.session.provider, a), f.identityFor(a));
  assert.deepEqual(measureNativeRequestIdentity(f.session.provider, b), f.identityFor(b));
  assert.deepEqual(f.measurements.map(value => value.continuationScope), ["scope:A", "scope:B"]);
  assert.deepEqual(f.counts(), { captures: 0, restores: 0, forks: 1 });

  for await (const _event of f.session.provider.stream(b, signal)) { /* local transport only */ }

  assert.equal(f.sends[0]?.continuationScope, "scope:B", "observing A must not lock the next actual stream to A");
  f.session.close();
});

test("later physical rounds measure and send the same retained task scope", async () => {
  const f = fixture(), a = request("scope:task"), b = request("scope:new-physical-round");

  for await (const _event of f.session.provider.stream(a, signal)) { /* local transport only */ }

  const measured = measureNativeRequestIdentity(f.session.provider, b);

  for await (const _event of f.session.provider.stream(b, signal)) { /* local transport only */ }

  assert.deepEqual(measured, f.identityFor(f.sends[1]!));
  assert.equal(f.measurements[0]?.continuationScope, f.sends[1]?.continuationScope);
  assert.equal(f.sends[1]?.continuationScope, "scope:task");
  assert.deepEqual(f.counts(), { captures: 0, restores: 0, forks: 1 });
  f.session.close();
});

test("a released child cannot authenticate native input or call the released measurement owner", () => {
  const f = fixture(), input = request("scope:closed");
  assert.ok(measureNativeRequestIdentity(f.session.provider, input));
  f.session.close();
  assert.equal(measureNativeRequestIdentity(f.session.provider, input), null);
  assert.equal(f.measurements.length, 1);
  assert.deepEqual(f.counts(), { captures: 0, restores: 1, forks: 1 });
});

test("a legacy child native port without a measurement hook remains explicitly unknown", () => {
  const f = fixture(false);
  assert.equal(f.session.provider.continuation?.measureRequestIdentity, undefined);
  assert.equal(measureNativeRequestIdentity(f.session.provider, request("scope:legacy")), null);
  assert.equal(f.measurements.length, 0);
  f.session.close();
});
