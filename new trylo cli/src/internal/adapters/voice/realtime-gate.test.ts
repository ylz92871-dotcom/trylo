import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceGate, MAX_VOICE_CHUNK_CHARS, type VoiceBackend } from "./realtime-gate.js";

/**
 * WP19.2 (C85) gate contract: no backend means no start, chunks are bounded
 * and counted, and a cancelled gate reports cancellation — never completion.
 */

function loopbackBackend(): VoiceBackend {
  return {
    async start() {
      return { ok: true };
    },
    async append() {
      return { ok: true };
    },
    async stop() {
      return { ok: true };
    },
  };
}

const READY = { device: "authorized", modelRealtime: "supported" } as const;

test("a gate without a backend refuses to start and stays idle", async () => {
  const gate = createVoiceGate({ readiness: READY });
  const refused = await gate.start(new AbortController().signal);

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "voice_unavailable");
  }

  assert.equal(gate.status().status, "idle");
});

test("a full loopback turn counts appends and stops with its delivery", async () => {
  const gate = createVoiceGate({ readiness: READY, backend: loopbackBackend() });
  const signal = new AbortController().signal;
  const started = await gate.start(signal);

  assert.equal(started.ok, true);
  assert.equal((await gate.append("audio", "QUJD", signal)).ok, true);
  assert.equal((await gate.append("text", "aGk=", signal)).ok, true);
  const stopped = await gate.stop(signal);

  assert.equal(stopped.ok, true);
  assert.deepEqual(gate.delivery(), { audioAppends: 1, textAppends: 1, speechAppends: 0 });
});

test("empty and oversize chunks refuse before reaching the backend", async () => {
  let backendCalls = 0;
  const counting: VoiceBackend = {
    async start() {
      return { ok: true };
    },
    async append() {
      backendCalls += 1;
      return { ok: true };
    },
    async stop() {
      return { ok: true };
    },
  };
  const gate = createVoiceGate({ readiness: READY, backend: counting });
  const signal = new AbortController().signal;

  assert.equal((await gate.start(signal)).ok, true);
  const empty = await gate.append("audio", "", signal);

  assert.equal(empty.ok, false);

  if (!empty.ok) {
    assert.equal(empty.code, "invalid_voice_payload");
  }

  const huge = await gate.append("audio", "A".repeat(MAX_VOICE_CHUNK_CHARS + 1), signal);

  assert.equal(huge.ok, false);

  if (!huge.ok) {
    assert.equal(huge.code, "voice_chunk_too_large");
  }

  assert.equal(backendCalls, 0);
});

test("a backend denial fails the session with the backend's code", async () => {
  const denying: VoiceBackend = {
    async start() {
      return { ok: false, code: "auth_expired", message: "auth_expired: realtime token refused" };
    },
    async append() {
      return { ok: true };
    },
    async stop() {
      return { ok: true };
    },
  };
  const gate = createVoiceGate({ readiness: READY, backend: denying });
  const refused = await gate.start(new AbortController().signal);

  assert.equal(refused.ok, true);

  if (refused.ok && refused.session.status === "failed") {
    assert.equal(refused.session.code, "auth_expired");
  } else {
    assert.fail("expected a failed session carrying the backend code");
  }
});

test("aborting mid-turn cancels the session instead of completing it", async () => {
  const gate = createVoiceGate({ readiness: READY, backend: loopbackBackend() });
  const controller = new AbortController();

  assert.equal((await gate.start(controller.signal)).ok, true);
  controller.abort();
  const cancelled = await gate.append("audio", "QUJD", controller.signal);

  assert.equal(cancelled.ok, true);
  assert.equal(gate.status().status, "cancelled");
});
