import {
  checkVoiceAvailability,
  initialVoiceSession,
  transitionVoice,
  type VoiceDelivery,
  type VoiceReadiness,
  type VoiceSession,
} from "../../domain/voice-session.js";

/**
 * Realtime voice gate (WP19.2: C85).
 *
 * The domain machine owns the lifecycle; this adapter owns the two things the
 * machine cannot: the injected realtime transport and the chunk ceiling.
 * Audio crosses as opaque base64 — never decoded, never logged — because this
 * package holds no codec and must not pretend to inspect what it forwards.
 *
 * There is no default backend. A gate built without one refuses `start` with
 * `backend_missing` (externally_blocked), which is the honest shape of this
 * package today: the lifecycle is wired, the transport is not.
 */

export const MAX_VOICE_CHUNK_CHARS = 1_400_000;

export type VoiceChunkKind = "audio" | "text" | "speech";

export type VoiceBackend = {
  start(signal: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }>;
  append(kind: VoiceChunkKind, payloadBase64: string, signal: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }>;
  stop(signal: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }>;
};

export type VoiceGateConfig = {
  readonly readiness: Omit<VoiceReadiness, "backend">;
  readonly backend?: VoiceBackend;
};

export type VoiceResult =
  | { readonly ok: true; readonly session: VoiceSession }
  | { readonly ok: false; readonly code: string; readonly message: string };

function refusal(code: string, message: string): VoiceResult {
  return { ok: false, code, message };
}

export function createVoiceGate(config: VoiceGateConfig): {
  readonly status: () => VoiceSession;
  readonly delivery: () => VoiceDelivery | undefined;
  start(signal: AbortSignal): Promise<VoiceResult>;
  append(kind: VoiceChunkKind, payloadBase64: string, signal: AbortSignal): Promise<VoiceResult>;
  stop(signal: AbortSignal): Promise<VoiceResult>;
  cancel(): VoiceResult;
} {
  let session: VoiceSession = initialVoiceSession();
  const backendState = config.backend === undefined ? "absent" : "present";

  function apply(
    event: Parameters<typeof transitionVoice>[1],
  ): VoiceResult {
    const next = transitionVoice(session, event);
    if (!next.ok) {
      return refusal(next.code, next.message);
    }
    session = next.session;
    return { ok: true, session };
  }

  return {
    status: () => session,
    delivery: () => {
      if (session.status === "live" || session.status === "stopping" || session.status === "stopped") {
        return session.delivered;
      }
      return undefined;
    },
    async start(signal: AbortSignal): Promise<VoiceResult> {
      const availability = checkVoiceAvailability({ ...config.readiness, backend: backendState });
      if (!availability.ok) {
        return refusal("voice_unavailable", availability.message);
      }

      const started = apply({ type: "start" });
      if (!started.ok) {
        return started;
      }

      if (signal.aborted) {
        return apply({ type: "cancel" });
      }

      try {
        const outcome = await (config.backend as VoiceBackend).start(signal);
        if (!outcome.ok) {
          return apply({ type: "backend_denied", code: outcome.code, message: outcome.message });
        }
        return apply({ type: "backend_ready" });
      } catch (error) {
        if (signal.aborted) {
          return apply({ type: "cancel" });
        }
        const message = error instanceof Error ? error.message : "backend threw";
        return apply({ type: "backend_error", code: "backend_threw", message: `backend_threw:${message}` });
      }
    },
    async append(kind: VoiceChunkKind, payloadBase64: string, signal: AbortSignal): Promise<VoiceResult> {
      if (payloadBase64.length === 0) {
        return refusal("invalid_voice_payload", "invalid_voice_payload: empty chunk");
      }

      if (payloadBase64.length > MAX_VOICE_CHUNK_CHARS) {
        return refusal(
          "voice_chunk_too_large",
          `voice_chunk_too_large: ${payloadBase64.length} chars exceeds ${MAX_VOICE_CHUNK_CHARS}`,
        );
      }

      if (session.status !== "live") {
        return refusal("illegal_voice_transition", `illegal_voice_transition: append_${kind} not allowed while ${session.status}`);
      }

      if (signal.aborted) {
        return apply({ type: "cancel" });
      }

      try {
        const outcome = await (config.backend as VoiceBackend).append(kind, payloadBase64, signal);
        if (!outcome.ok) {
          return apply({ type: "backend_error", code: outcome.code, message: outcome.message });
        }
        return apply(kind === "audio" ? { type: "append_audio" } : kind === "text" ? { type: "append_text" } : { type: "append_speech" });
      } catch (error) {
        if (signal.aborted) {
          return apply({ type: "cancel" });
        }
        const message = error instanceof Error ? error.message : "backend threw";
        return apply({ type: "backend_error", code: "backend_threw", message: `backend_threw:${message}` });
      }
    },
    async stop(signal: AbortSignal): Promise<VoiceResult> {
      const requested = apply({ type: "request_stop" });
      if (!requested.ok) {
        return requested;
      }

      try {
        const outcome = await (config.backend as VoiceBackend).stop(signal);
        if (!outcome.ok) {
          return apply({ type: "backend_error", code: outcome.code, message: outcome.message });
        }
        return apply({ type: "backend_stopped" });
      } catch (error) {
        if (signal.aborted) {
          return apply({ type: "cancel" });
        }
        const message = error instanceof Error ? error.message : "backend threw";
        return apply({ type: "backend_error", code: "backend_threw", message: `backend_threw:${message}` });
      }
    },
    cancel(): VoiceResult {
      return apply({ type: "cancel" });
    },
  };
}
