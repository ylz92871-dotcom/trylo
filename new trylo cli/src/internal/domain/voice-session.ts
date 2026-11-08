/**
 * Voice/Realtime session state machine (WP19.2: C85, A10-voice).
 *
 * One owner for "where a voice turn stands". States are an explicit union —
 * never a pile of booleans — so `live` always means exactly one thing, and a
 * cancelled session can never look like a completed one.
 *
 * Reuse: Codex `tui/.../slash_dispatch.rs:336` (`/voice` toggle),
 * `app-server/.../turn_processor.rs:277` (real start), and the experimental
 * `thread/realtime/*` RPC family (`common.rs:1046`). Only the lifecycle
 * shape is ported: Transports, codecs, and device I/O stay behind the
 * `RealtimeBackend` seam in `adapters/voice`, because this package ships no
 * audio device or realtime transport today.
 */

export const VOICE_STATUSES = [
  "idle",
  "starting",
  "live",
  "stopping",
  "stopped",
  "cancelled",
  "failed",
] as const;

export type VoiceStatus = (typeof VOICE_STATUSES)[number];

export type VoiceDelivery = {
  readonly audioAppends: number;
  readonly textAppends: number;
  readonly speechAppends: number;
};

export type VoiceSession =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "live"; readonly delivered: VoiceDelivery }
  | { readonly status: "stopping"; readonly delivered: VoiceDelivery }
  | { readonly status: "stopped"; readonly delivered: VoiceDelivery }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly code: string; readonly message: string };

export function initialVoiceSession(): VoiceSession {
  return { status: "idle" };
}

function emptyDelivery(): VoiceDelivery {
  return { audioAppends: 0, textAppends: 0, speechAppends: 0 };
}

export type VoiceEvent =
  | { readonly type: "start" }
  | { readonly type: "backend_ready" }
  | { readonly type: "backend_denied"; readonly code: string; readonly message: string }
  | { readonly type: "append_audio" }
  | { readonly type: "append_text" }
  | { readonly type: "append_speech" }
  | { readonly type: "request_stop" }
  | { readonly type: "backend_stopped" }
  | { readonly type: "cancel" }
  | { readonly type: "backend_error"; readonly code: string; readonly message: string };

export type VoiceTransition =
  | { readonly ok: true; readonly session: VoiceSession }
  | { readonly ok: false; readonly code: "illegal_voice_transition"; readonly message: string };

function illegal(session: VoiceSession, event: VoiceEvent): VoiceTransition {
  return {
    ok: false,
    code: "illegal_voice_transition",
    message: `illegal_voice_transition: ${event.type} not allowed while ${session.status}`,
  };
}

/**
 * One event, one transition. A fresh session object starts every voice turn:
 * `cancelled`, `failed`, and `stopped` are terminal here, and restarting
 * reuses nothing — which is what keeps a previous turn's audio counts from
 * leaking into the next turn's delivery summary.
 */
export function transitionVoice(session: VoiceSession, event: VoiceEvent): VoiceTransition {
  switch (event.type) {
    case "start":
      return session.status === "idle" || session.status === "stopped"
        ? { ok: true, session: { status: "starting" } }
        : illegal(session, event);
    case "backend_ready":
      return session.status === "starting"
        ? { ok: true, session: { status: "live", delivered: emptyDelivery() } }
        : illegal(session, event);
    case "backend_denied":
      return session.status === "starting"
        ? { ok: true, session: { status: "failed", code: event.code, message: event.message } }
        : illegal(session, event);
    case "append_audio":
    case "append_text":
    case "append_speech":
      if (session.status !== "live") {
        return illegal(session, event);
      }
      return {
        ok: true,
        session: {
          status: "live",
          delivered: {
            audioAppends: session.delivered.audioAppends + (event.type === "append_audio" ? 1 : 0),
            textAppends: session.delivered.textAppends + (event.type === "append_text" ? 1 : 0),
            speechAppends: session.delivered.speechAppends + (event.type === "append_speech" ? 1 : 0),
          },
        },
      };
    case "request_stop":
      return session.status === "live"
        ? { ok: true, session: { status: "stopping", delivered: session.delivered } }
        : illegal(session, event);
    case "backend_stopped":
      return session.status === "stopping"
        ? { ok: true, session: { status: "stopped", delivered: session.delivered } }
        : illegal(session, event);
    case "cancel":
      return session.status === "starting" || session.status === "live" || session.status === "stopping"
        ? { ok: true, session: { status: "cancelled" } }
        : illegal(session, event);
    case "backend_error":
      return session.status === "starting" || session.status === "live" || session.status === "stopping"
        ? { ok: true, session: { status: "failed", code: event.code, message: event.message } }
        : illegal(session, event);
  }
}

export type VoiceReadiness = {
  /** A realtime transport is injected. Absent means there is nothing to start. */
  readonly backend: "present" | "absent";
  /** Microphone/playback authorization the platform reported. */
  readonly device: "authorized" | "denied" | "unknown";
  /** Whether the active model speaks realtime at all. */
  readonly modelRealtime: "supported" | "unsupported" | "unknown";
};

export type VoiceAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "backend_missing" | "device_denied" | "device_unknown" | "model_unsupported"; readonly message: string };

/**
 * Fail-closed readiness: an unknown device state refuses exactly like a
 * denial, because starting to record without proven authorization is the
 * failure this gate exists to prevent.
 */
export function checkVoiceAvailability(readiness: VoiceReadiness): VoiceAvailability {
  if (readiness.backend === "absent") {
    return { ok: false, reason: "backend_missing", message: "voice_unavailable: no realtime backend configured (externally_blocked)" };
  }

  if (readiness.device === "denied") {
    return { ok: false, reason: "device_denied", message: "voice_unavailable: audio device denied" };
  }

  if (readiness.device === "unknown") {
    return { ok: false, reason: "device_unknown", message: "voice_unavailable: audio device authorization unproven" };
  }

  if (readiness.modelRealtime === "unsupported") {
    return { ok: false, reason: "model_unsupported", message: "voice_unavailable: model does not support realtime voice" };
  }

  return { ok: true };
}
