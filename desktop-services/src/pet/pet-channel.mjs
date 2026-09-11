// Trylo Desktop Services — pet channel. Wraps the legacy companion bridge for
// the Service Host. See migration spec §5.2 / §5.5 / §6.4.
//
// Owns: the lifetime of ONE createDesktopCompanionBridge instance, keyed to the
// first pet.enable(workspacePath). The legacy module stays byte-identical; we
// only adapt it to the NDJSON frame surface:
//   pet.enable / pet.disable / pet.openChat / pet.publish / pet.chatHandle
//     (request, D→S)
//   host.permissionDecision (event, S→D) — bridge permission callback
//   host.petChat (event, S→D) — bridge chatRequestHandler, gated to mode 'chat'
//
// Chat flow: the bridge hands us (message, emit); we notify Desktop via
// host.petChat and — once host.mjs installs a dispatcher (the pet-chat
// module) — Desktop drives the actual handling back through pet.chatHandle,
// passing the per-request chat config. The dispatcher's output goes through
// the captured emit (the bridge's TCP chat socket) so replies reach the WPF
// window directly from the sidecar.
//
// Failure policy: binding a channel is only possible when the sidecar knows its
// sidecars dir (TRYLO_SIDECARS_DIR). If the companion exe is unavailable on
// win32 the bridge's launchCompanion() returns false and pet.status reports
// exeFound:false; we never stub a pet that isn't there.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/// Stable reason codes for `pet.status` (audit §4.2 PET-P0-2). The renderer
/// never parses a message string — it switches on these.
export const PET_REASON = {
  NOT_ATTEMPTED: 'not_attempted',
  NO_SIDECARS_DIR: 'no_sidecars_dir',
  BRIDGE_MODULE_MISSING: 'bridge_module_missing',
  EXE_NOT_FOUND: 'exe_not_found',
  SPAWN_FAILED: 'spawn_failed',
  SPAWN_NO_PID: 'spawn_no_pid',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  BRIDGE_UNAVAILABLE: 'bridge_unavailable',
};

/// Sanitised stderr note. `message` MUST already be free of secrets and of
/// absolute private paths (callers pass a reason code).
function stderrNote(message) {
  try {
    process.stderr.write(`[pet] ${String(message).slice(0, 300)}\n`);
  } catch {
    /* stderr may be gone */
  }
}

/** Empty status shape — every field is always present so the renderer can
 *  destructure without optional chaining. */
function emptyStatus(reasonCode) {
  return {
    enabled: false,
    exeFound: false,
    launchAttempted: false,
    launched: false,
    chatConnected: false,
    exePath: '',
    reasonCode,
  };
}

/**
 * Locate the byte-identical vendor bridge. The naive module-relative
 * `require('../..vendor/...')` breaks once this module is INLINED into
 * `dist/host.bundle.mjs` by esbuild: import.meta.url then points at the
 * bundle, and `../..` escapes the package root (verified 2026-08-28:
 * MODULE_NOT_FOUND → the pet silently never launches). Candidates cover
 * every shipped layout:
 *   - `node src/host.mjs` (dev, unbundled): src/pet/../../vendor
 *   - `node dist/host.bundle.mjs` (bundled): dist/../vendor
 *   - packaged resource copy: <resource>/desktop-services/dist/../vendor
 */
function resolveVendorBridgeModule() {
  const rel = path.join('vendor', 'legacy', 'desktop-companion-bridge.js');
  const candidates = [];
  if (process.argv[1]) {
    // Both entry layouts sit ONE level below the package root.
    candidates.push(path.resolve(path.dirname(path.resolve(process.argv[1])), '..', rel));
  }
  // Unbundled fallback: this file really lives at src/pet/.
  candidates.push(fileURLToPath(new URL('../../' + rel, import.meta.url)));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function createPetChannel(ctx, events) {
  // `bridge` is the createDesktopCompanionBridge instance; null between enable
  // and (re)enable, and after disable.
  let bridge = null;
  let workspacePath = '';
  let enabled = false;
  // Chat dispatch: `chatDispatcher` is installed by host.mjs (the pet-chat
  // module); `lastChatEmit` is the bridge's per-message emit closure — one
  // TCP chat socket per bridge, so the latest emit is THE way back to the
  // WPF window.
  let chatDispatcher = null;
  let lastChatEmit = null;
  // Why the last `bind()` refused to create a bridge. Kept so a failed
  // enable reports the ACTUAL cause instead of a generic
  // `bridge_unavailable`.
  let bindFailure = '';

  /// Project the bridge's real state. `bridge.getStatus()` is the vendor
  /// bridge's read-only projection (audit §4.2 PET-P0-2): exeFound /
  /// launched / chatConnected are FACTS, not inferences.
  function readStatus(reasonCode = '') {
    if (!bridge) return emptyStatus(reasonCode || bindFailure || PET_REASON.BRIDGE_UNAVAILABLE);
    const raw = typeof bridge.getStatus === 'function' ? bridge.getStatus() : {};
    return {
      enabled: Boolean(raw.enabled),
      exeFound: Boolean(raw.exeFound),
      // "we never tried" and "we tried and failed" are different states with
      // different user-facing copy — keep them distinguishable.
      launchAttempted: Boolean(raw.launchAttempted),
      launched: Boolean(raw.launched),
      chatConnected: Boolean(raw.chatConnected),
      exePath: String(raw.exePath || ''),
      reasonCode: String(raw.reasonCode || reasonCode || ''),
    };
  }

  function emitStatus(reasonCode = '') {
    events.emit('pet.status', readStatus(reasonCode));
  }

  function bind() {
    if (bridge) return;
    bindFailure = '';
    const sidecarsDir = process.env.TRYLO_SIDECARS_DIR;
    if (!sidecarsDir) {
      bindFailure = PET_REASON.NO_SIDECARS_DIR;
      emitStatus(bindFailure);
      return;
    }
    const bridgeModule = resolveVendorBridgeModule();
    if (!bridgeModule) {
      // Fail closed with a loud, sanitized diagnostic — a silent no-pet
      // is exactly the failure mode that took a debug round to find.
      bindFailure = PET_REASON.BRIDGE_MODULE_MISSING;
      emitStatus(bindFailure);
      stderrNote(`vendor desktop-companion-bridge.js not found (${bindFailure})`);
      return;
    }
    const mod = require(bridgeModule);
    bridge = mod.createDesktopCompanionBridge({
      extensionPath: sidecarsDir,
      workspacePath,
    });
    // Re-publish on chat-connectivity changes (audit §4.3): the chat socket
    // connects asynchronously, so the status emitted synchronously by
    // `enable()` always reports `chatConnected: false`. Without this, the UI
    // would show "Starting" forever on a perfectly healthy pet.
    if (typeof bridge.setChatStateHandler === 'function') {
      bridge.setChatStateHandler(() => emitStatus());
    }
    // Permission decision arrives on the bridge; forward to Desktop.
    bridge.setPermissionDecisionHandler((payload) => {
      events.emit('host.permissionDecision', payload);
    });
    bridge.setChatRequestHandler((message, emit) => {
      // Only Chat mode is migrated. Fun (猫箱) is explicitly unsupported.
      const mode = String(message?.mode || 'chat').toLowerCase();
      if (mode !== 'chat') {
        emit({
          type: 'chat_error',
          requestId: String(message.requestId || ''),
          mode,
          error: '本版本不支持猫箱(Fun)模式。',
        });
        return Promise.resolve();
      }
      // Capture the emit and hand the request to Desktop (host.petChat).
      // The sidecar never handles chat on its own: the LLM config is
      // injected by Desktop via pet.chatHandle, so an unhandled request
      // (renderer gone) simply stays unanswered instead of failing with a
      // misleading config error.
      lastChatEmit = emit;
      events.emit('host.petChat', { ...message });
      return Promise.resolve();
    });
    bridge.publish({ type: 'agentState', state: 'idle', detail: 'Ready', level: 'info', meta: {} });
    // Deliberately NO status emit here: `bind()` only creates the bridge,
    // the launch happens in `enable()`. Emitting now would publish
    // `not_attempted` about an attempt that is about to happen — the UI
    // would flicker a false "not attempted" over the real reason.
  }

  function enable(params) {
    workspacePath = String(params?.workspacePath || '');
    bind();
    if (bridge) {
      bridge.enable();
      enabled = true;
    }
    // The bridge launches synchronously inside enable(), so `launched` is
    // already a fact by the time we read it.
    const status = readStatus();
    events.emit('pet.status', status);
    if (!status.launched && status.reasonCode) {
      stderrNote(`pet.enable did not launch: ${status.reasonCode}`);
    }
    return { ok: Boolean(bridge), ...status };
  }

  function disable() {
    if (bridge) bridge.disable();
    enabled = false;
    emitStatus(PET_REASON.NOT_ATTEMPTED);
    return { ok: true };
  }

  function openChat() {
    bind();
    if (bridge) bridge.openChat();
    const status = readStatus();
    events.emit('pet.status', status);
    return { ok: Boolean(bridge), ...status };
  }

  /// Pet status query. Registered as `pet.status` so Desktop can poll the
  /// real state on demand (audit §4.2 PET-P0-1) instead of inferring it
  /// from "did a pet.status event arrive".
  function status() {
    return readStatus();
  }

  function publish(payload) {
    if (bridge) bridge.publish(payload);
    return { ok: true };
  }

  /** D→S `pet.chatHandle`: Desktop received host.petChat and now drives the
   *  handling (store + LLM) inside the sidecar, injecting the per-request
   *  chat config. Output flows to the WPF via the captured bridge emit.
   *  Params: { message, chat? }. Mode is re-validated inside the
   *  dispatcher (fail closed). */
  function chatHandle(params) {
    const message = params && params.message;
    if (!message || typeof message !== 'object') {
      return Promise.resolve({ ok: false, error: 'pet.chatHandle requires { message }' });
    }
    if (!chatDispatcher) {
      return Promise.resolve({ ok: false, error: 'chat dispatcher is not installed' });
    }
    if (!lastChatEmit) {
      return Promise.resolve({ ok: false, error: 'no active companion chat session' });
    }
    return Promise.resolve()
      .then(() => chatDispatcher(message, lastChatEmit, params.chat))
      .then(() => ({ ok: true }))
      .catch((err) => ({
        ok: false,
        error: err && err.message ? String(err.message) : 'pet.chatHandle failed',
      }));
  }

  /** host.mjs installs the pet-chat dispatcher here. */
  function setChatDispatcher(fn) {
    chatDispatcher = typeof fn === 'function' ? fn : null;
  }

  return {
    enable,
    disable,
    openChat,
    publish,
    chatHandle,
    setChatDispatcher,
    status,
    get enabled() {
      return enabled;
    },
  };
}