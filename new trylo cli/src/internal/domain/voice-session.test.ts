import assert from "node:assert/strict";
import test from "node:test";
import {
  checkVoiceAvailability,
  initialVoiceSession,
  transitionVoice,
  type VoiceSession,
} from "./voice-session.js";

/**
 * WP19.2 (C85) contract: the full transition table, terminal states that
 * stay terminal, and fail-closed availability. A chooser stub elsewhere must
 * never be able to report what this machine never reached.
 */

function live(): VoiceSession {
  const started = transitionVoice(initialVoiceSession(), { type: "start" });

  assert.equal(started.ok, true);

  if (!started.ok) {
    throw new Error("unreachable");
  }

  const ready = transitionVoice(started.session, { type: "backend_ready" });

  assert.equal(ready.ok, true);

  if (!ready.ok) {
    throw new Error("unreachable");
  }

  return ready.session;
}

test("a full turn delivers counts and stops exactly once", () => {
  let session = live();

  for (const event of [{ type: "append_audio" }, { type: "append_text" }, { type: "append_speech" }, { type: "append_audio" }] as const) {
    const next = transitionVoice(session, event);
    assert.equal(next.ok, true);
    if (next.ok) {
      session = next.session;
    }
  }

  assert.deepEqual(session.status === "live" ? session.delivered : undefined, {
    audioAppends: 2,
    textAppends: 1,
    speechAppends: 1,
  });
  const stopping = transitionVoice(session, { type: "request_stop" });

  assert.equal(stopping.ok, true);

  if (!stopping.ok) {
    throw new Error("unreachable");
  }

  const stopped = transitionVoice(stopping.session, { type: "backend_stopped" });

  assert.equal(stopped.ok, true);

  if (stopped.ok) {
    assert.equal(stopped.session.status, "stopped");
    // A stopped session may start the next turn, but it is a new starting state.
    const restart = transitionVoice(stopped.session, { type: "start" });
    assert.equal(restart.ok, true);
  }
});

test("appends outside live, double stops, and late cancels are illegal", () => {
  const idle = initialVoiceSession();

  for (const event of [{ type: "append_audio" }, { type: "request_stop" }, { type: "backend_stopped" }, { type: "cancel" }] as const) {
    const refused = transitionVoice(idle, event);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.code, "illegal_voice_transition");
    }
  }

  const session = live();

  assert.equal(transitionVoice(session, { type: "start" }).ok, false);
  assert.equal(transitionVoice(session, { type: "backend_ready" }).ok, false);
  assert.equal(transitionVoice(session, { type: "backend_stopped" }).ok, false);
});

test("cancel is terminal from every active state and never from a settled one", () => {
  const starting = transitionVoice(initialVoiceSession(), { type: "start" });

  assert.equal(starting.ok, true);

  if (starting.ok) {
    assert.equal(transitionVoice(starting.session, { type: "cancel" }).ok, true);
  }

  const cancelled = transitionVoice(live(), { type: "cancel" });

  assert.equal(cancelled.ok, true);

  if (cancelled.ok) {
    assert.equal(cancelled.session.status, "cancelled");
    assert.equal(transitionVoice(cancelled.session, { type: "start" }).ok, false);
    assert.equal(transitionVoice(cancelled.session, { type: "cancel" }).ok, false);
  }
});

test("backend denial and mid-turn errors carry their codes into failed", () => {
  const starting = transitionVoice(initialVoiceSession(), { type: "start" });

  assert.equal(starting.ok, true);

  if (starting.ok) {
    const denied = transitionVoice(starting.session, { type: "backend_denied", code: "auth_expired", message: "auth_expired: realtime token refused" });
    assert.equal(denied.ok, true);
    if (denied.ok) {
      assert.equal(denied.session.status, "failed");
    }
  }

  const errored = transitionVoice(live(), { type: "backend_error", code: "transport_lost", message: "transport_lost: socket closed" });

  assert.equal(errored.ok, true);

  if (errored.ok && errored.session.status === "failed") {
    assert.equal(errored.session.code, "transport_lost");
  }
});

test("availability refuses missing backends, unproven devices, and unsupported models", () => {
  const ready = { backend: "present", device: "authorized", modelRealtime: "supported" } as const;

  assert.equal(checkVoiceAvailability(ready).ok, true);
  assert.equal(checkVoiceAvailability({ ...ready, backend: "absent" }).ok, false);
  assert.equal(checkVoiceAvailability({ ...ready, device: "denied" }).ok, false);
  // Unknown is not a maybe: recording without proven authorization never starts.
  const unknown = checkVoiceAvailability({ ...ready, device: "unknown" });

  assert.equal(unknown.ok, false);

  if (!unknown.ok) {
    assert.equal(unknown.reason, "device_unknown");
  }

  const model = checkVoiceAvailability({ ...ready, modelRealtime: "unsupported" });

  assert.equal(model.ok, false);

  if (!model.ok) {
    assert.equal(model.reason, "model_unsupported");
  }
});
