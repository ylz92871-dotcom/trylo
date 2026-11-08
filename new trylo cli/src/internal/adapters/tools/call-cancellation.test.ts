import assert from "node:assert/strict";
import { test } from "node:test";

import { createCallCancellationRegistry, linkedSignal } from "./call-cancellation.js";

/**
 * The channel that makes `cancel(toolCallId)` mean something.
 *
 * Before this existed, every mutating tool implemented `cancel` as an empty
 * body, so a cancel dispatched by the loop reached no running process at all.
 * These cases pin the two halves of the fix: a stop reaches the call that is
 * actually open, and it reaches nothing that is not.
 */

test("a registered call is stopped by its id", () => {
  const registry = createCallCancellationRegistry();
  const controller = registry.begin("call-1");
  assert.equal(controller.signal.aborted, false);
  assert.equal(registry.cancel("call-1"), true);
  assert.equal(controller.signal.aborted, true);
});

test("cancelling an id that is not running reports false rather than throwing", () => {
  const registry = createCallCancellationRegistry();
  assert.equal(registry.cancel("never-started"), false);
});

test("stopping twice is safe and stays true", () => {
  const registry = createCallCancellationRegistry();
  const controller = registry.begin("call-1");
  assert.equal(registry.cancel("call-1"), true);
  assert.equal(registry.cancel("call-1"), true, "a second stop is not an error");
  assert.equal(controller.signal.aborted, true);
});

test("a settled call is forgotten and no longer answers to its id", () => {
  const registry = createCallCancellationRegistry();

  registry.begin("call-1");
  registry.end("call-1");
  assert.equal(registry.size, 0);
  assert.equal(registry.cancel("call-1"), false, "a settled call has nothing to stop");
  registry.end("call-1"); // idempotent
  assert.equal(registry.size, 0);
});

test("two concurrent calls are stopped independently", () => {
  const registry = createCallCancellationRegistry();
  const first = registry.begin("call-1");
  const second = registry.begin("call-2");

  assert.equal(registry.size, 2);
  registry.cancel("call-1");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false, "stopping one call must not stop its sibling");
});

test("the linked signal fires when the turn is cancelled", () => {
  const registry = createCallCancellationRegistry();
  const turn = new AbortController();
  const own = registry.begin("call-1");
  const link = linkedSignal(turn.signal, own.signal);

  assert.equal(link.signal.aborted, false);
  turn.abort();
  assert.equal(link.signal.aborted, true);
  link.release();
});

test("the linked signal fires when only this call is stopped", () => {
  const registry = createCallCancellationRegistry();
  const turn = new AbortController();
  const own = registry.begin("call-1");
  const link = linkedSignal(turn.signal, own.signal);

  registry.cancel("call-1");
  assert.equal(link.signal.aborted, true);
  assert.equal(turn.signal.aborted, false, "stopping a call must not cancel the turn");
  link.release();
});

test("a turn signal already aborted when linked is honoured immediately", () => {
  // A cancel can land between the loop's check and the tool starting. Missing
  // it would leave the tool running with nobody left to stop it.
  const turn = new AbortController();

  turn.abort();
  const own = new AbortController();
  const link = linkedSignal(turn.signal, own.signal);

  assert.equal(link.signal.aborted, true);
  link.release();
});

test("release detaches from both sources, leaving nothing behind on the turn", () => {
  const registry = createCallCancellationRegistry();
  const turn = new AbortController();
  const own = registry.begin("call-1");
  const link = linkedSignal(turn.signal, own.signal);

  link.release();
  // Neither source firing afterwards may reach the settled call's signal.
  assert.equal(link.signal.aborted, false);
  turn.abort();
  assert.equal(link.signal.aborted, false, "a released link must ignore a late abort");
  assert.equal(registry.cancel("call-1"), true, "the call is still open until it ends");
});
