// Trylo Desktop Services — Service Host entry. NDJSON stdio loop.
// See migration spec §5.1 / §5.5.
//
// The host is spawned by the Tauri shell (servicehost.rs) with
// stdin/stdout carrying frames; it never opens a listening port. It:
//   1. reads newline-delimited frames from stdin,
//   2. dispatches to the registry (unknown method => UNKNOWN_METHOD), and
//   3. writes responses/events to stdout.
// A 10s ping keeps the parent alive; on clean stdin close it exits 0.
//
// Ownership/failure policy:
//   - stderr is reserved for sanitised diagnostics only (no prompts/keys).
//   - a malformed single line is dropped, never fatal.
//   - unknown method/version are reported as error frames (fail-closed).
// Env contract: TRYLO_APP_DATA_DIR, TRYLO_SIDECARS_DIR, HERMES_PYTHON (optional).

import { createRequire } from 'node:module';
import readline from 'node:readline';

import { decodeRaw, encode, errorFrame, eventFrame } from './protocol/frames.mjs';
import { MethodRegistry, UNKNOWN_METHOD } from './protocol/registry.mjs';
import { createPetChannel } from './pet/pet-channel.mjs';
import { createPetChat } from './pet-chat/index.mjs';
import { createLearningServices } from './learning/index.mjs';
import { createRemoteServices } from './remote/index.mjs';
import { createToolingServices } from './tooling/index.mjs';

const require = createRequire(import.meta.url);

const PING_INTERVAL_MS = 10_000;

/// stderr carries sanitised diagnostics only (spec §5.1): no prompts, no
/// tokens, no absolute private paths. Domain helpers call this instead of
/// console.warn so every line goes through one redaction point.
function stderrDiagnostics(message) {
  try {
    process.stderr.write(`[desktop-services] ${String(message).slice(0, 500)}\n`);
  } catch {
    /* stderr unavailable; diagnostics are best-effort */
  }
}

function currentVersion() {
  // Best-effort; absent a committed dist the version is the package version.
  try {
    const pkg = require('../package.json');
    return `desktop-services@${pkg.version}`;
  } catch {
    return 'desktop-services@dev';
  }
}

export function createHost({ stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, autoExit = true } = {}) {
  const registry = new MethodRegistry();

  const emit = {
    emit(topic, payload) {
      try {
        stdout.write(encode(eventFrame(topic, payload)));
        stdout.write('\n');
      } catch {
        /* diagnostics only */
      }
    },
  };

  // Pet channel (Phase 1: only the pet domain is wired; learning.* / remote.*
  // register here as their Phases land).
  // Learning domain (Phase 3). configureHermesEnv() runs inside
  // createLearningServices and MUST happen before any vendored Hermes module
  // is required — those resolve their Python script paths at load time
  // (vendor/PATCHES.md patches 1–6). Every learning service therefore
  // requires its legacy module lazily.
  const learning = createLearningServices({ log: stderrDiagnostics });

  // Remote domain (Phase 4, spec §8.1). The gateway runs inside the sidecar
  // and forwards every handler to the Desktop (host.remoteRequest →
  // remote.respond). Fun is rejected 501 at the adapter; tokens live only in
  // identity.mjs — never logged.
  const remote = createRemoteServices({
    emit: emit.emit.bind(emit),
    log: stderrDiagnostics,
  });

  const pet = createPetChannel(emit, {
    emit: emit.emit,
  });

  // Tooling domain (spec TRYLO-CORE-AGENT-TOOL-EXTENSION §12.1/§12.2).
  // Independent of the learning domain: the catalog, the package manager and
  // the Profile combiner own tool packages; Hermes stays behind its own
  // adapter and is only asked for its server definitions (§3.1).
  // `emit` also powers the viewport bridge's screencast frames
  // (`tooling.viewportFrame` / `tooling.viewportStatus` events).
  const tooling = createToolingServices({ log: stderrDiagnostics, emit: emit.emit });

  const ctx = {
    registry,
    events: emit.emit.bind(emit),
    env: process.env,
  };

  // Pet chat (Phase 2, spec §6.4): history under
  // <TRYLO_APP_DATA_DIR>/Trylo/companion/desktop-chat.json; the LLM config
  // is injected per request by Desktop via pet.chatHandle — never stored in
  // the sidecar. Every chat_* frame that goes back to the WPF window is
  // mirrored to Desktop as a `petChatEmit` event (observability only; the
  // Desktop never reads chat bodies for logic).
  const petChat = createPetChat({ appDataDir: process.env.TRYLO_APP_DATA_DIR || '' });
  pet.setChatDispatcher((message, emitToWpf, chatConfig) =>
    petChat.handle(message, (payload) => {
      emit.emit('petChatEmit', payload);
      emitToWpf(payload);
    }, chatConfig));

  registry
    .register('pet', 'enable', (params) => pet.enable(params))
    .register('pet', 'disable', () => pet.disable())
    .register('pet', 'openChat', () => pet.openChat())
    // Query (audit §4.2 PET-P0-1): Desktop polls this to learn whether the
    // companion exe was found / launched / connected — without guessing from
    // the presence of a `pet.status` event.
    .register('pet', 'status', () => pet.status())
    .register('pet', 'publish', (payload) => pet.publish(payload))
    .register('pet', 'chatHandle', (params) => pet.chatHandle(params));

  // Learning domain (Phase 3, spec §7.5). 3A read-only + session mirror are
  // registered first; 3B staged write follows; 3C (learning loop) appends
  // here when it lands.
  registry
    .register('learning', 'health', () => learning.healthCheck())
    .register('learning', 'mcpArgs', (params) => learning.mcpArgsFor(params))
    .register('learning', 'memorySnapshot', () => learning.memorySnapshot())
    .register('learning', 'skills', (params) => learning.skillsQuery(params))
    .register('session', 'sync', (params) => learning.sessionSync(params))
    .register('session', 'rebuild', (params) => learning.sessionRebuild(params))
    .register('session', 'flush', () => learning.sessionFlush())
    .register('learning', 'pendingList', () => learning.pendingList())
    .register('learning', 'pendingDetail', (params) => learning.pendingDetail(params))
    .register('learning', 'pendingApply', (params) => learning.pendingApply(params))
    .register('learning', 'pendingDiscard', (params) => learning.pendingDiscard(params))
    .register('learning', 'pendingBackupList', () => learning.pendingBackupList())
    .register('learning', 'pendingRollback', (params) => learning.pendingRollback(params))
    .register('learning', 'pendingProposeSkill', (params) => learning.pendingProposeSkill(params))
    .register('learning', 'copyTemplateUnderOut', (params) => learning.copyTemplateUnderOut(params));

  // 3C: learning loop (spec §7.6). Reviews produce STAGED proposals only —
  // nothing is applied without the pending apply path above.
  registry
    .register('learning', 'reviewImplicit', (params) => learning.reviewImplicit(params))
    .register('learning', 'learnExplicit', (params) => learning.learnExplicit(params))
    .register('learning', 'runStatus', (params) => learning.runStatus(params))
    .register('learning', 'historySearch', (params) => learning.historySearch(params))
    // Hermes 0.19.0 journey/L4/L5/L6 surfaces. These are adapters over the
    // already-vendored implementation, not a second learning framework.
    .register('learning', 'graphSummary', (params) => learning.graphSummary(params))
    .register('learning', 'qualityScan', (params) => learning.qualityScan(params))
    .register('learning', 'historyMine', (params) => learning.historyMine(params))
    .register('learning', 'jobs', (params) => learning.jobsManage(params));

  // Legacy data import (spec §7.5): discover → copy (never overwrite) →
  // verify → mark imported. Re-runnable; the old location is never deleted.
  registry
    .register('learning', 'importPlan', (params) => learning.importLegacyPlan(params))
    .register('learning', 'importCommit', (params) => learning.importLegacyCommit(params));

  // Remote domain (Phase 4, spec §8.1). Desktop owns every gateway handler;
  // the adapter forwards them as host.remoteRequest and Desktop answers via
  // remote.respond. remote.publish is the projection's D→S push into the
  // gateway's in-memory snapshot.
  registry
    .register('remote', 'status', () => remote.status())
    .register('remote', 'enable', (params) => remote.enable(params))
    .register('remote', 'disable', () => remote.disable())
    .register('remote', 'publish', (event) => remote.publish(event))
    .register('remote', 'pairingInfo', () => remote.pairingInfo())
    .register('remote', 'respond', (params) => remote.respond(params))
    .register('remote', 'emit', (params) => remote.emitToHandler(params))
    .register('remote', 'importIdentity', (params) => remote.importIdentity(params));

  // Tooling domain (spec §12.2). `resolveProfile` is on the hot path of every
  // Code/Work send — it must never throw and never block a run: a broken
  // tool package removes a capability, not the conversation (§4.4).
  registry
    .register('tooling', 'resolveProfile', (params) => tooling.resolveProfile(params))
    .register('tooling', 'health', (params) => tooling.health(params))
    .register('tooling', 'listProfiles', () => tooling.listProfiles())
    .register('tooling', 'install', (params) => tooling.install(params))
    .register('tooling', 'uninstall', (params) => tooling.uninstall(params))
    .register('tooling', 'setLocalOverride', (params) => tooling.setLocalOverride(params))
    .register('tooling', 'clearLocalOverride', (params) => tooling.clearLocalOverride(params))
    .register('tooling', 'localOverrides', () => tooling.localOverrides())
    .register('tooling', 'installBrowser', (params) => tooling.installBrowser(params))
    .register('tooling', 'listRuntimeArtifacts', (params) => tooling.listRuntimeArtifacts(params))
    .register('tooling', 'promoteArtifact', (params) => tooling.promoteArtifact(params))
    .register('tooling', 'sweepToolCache', () => tooling.sweepToolCache())
    .register('tooling', 'officeValidationCapabilities', (params) => tooling.officeValidationCapabilities(params))
    .register('tooling', 'validateOfficeArtifacts', (params) => tooling.validateOfficeArtifacts(params))
    .register('tooling', 'viewportStart', (params) => tooling.viewportStart(params))
    .register('tooling', 'viewportNavigate', (params) => tooling.viewportNavigate(params))
    .register('tooling', 'viewportInput', (params) => tooling.viewportInput(params))
    .register('tooling', 'viewportStop', () => tooling.viewportStop());
  function handleRequest(frame) {
    const { id, method, params } = frame;
    registry.dispatch(method, params, ctx).then((outcome) => {
      if (!outcome.handled) {
        stdout.write(encode(errorFrame(id, UNKNOWN_METHOD, `unknown method '${method}'`)));
        stdout.write('\n');
        return;
      }
      if (outcome.isError) {
        stdout.write(encode(errorFrame(id, outcome.code, outcome.message)));
      } else {
        stdout.write(encode({ version: 1, type: 'response', id, ok: true, result: outcome.result }));
      }
      stdout.write('\n');
      // Flush so the parent sees each frame promptly over stdio.
      try {
        stdout.write('');
      } catch {
        /* noop */
      }
    });
  }

  let rl = null;

  function start() {
    // Announce readiness on stdout as the Tauri shell waits for it.
    stdout.write(encode({ version: 1, type: 'event', topic: 'ready', payload: { version: currentVersion() } }));
    stdout.write('\n');

    // The maintenance scheduler is Desktop-owned. Startup is deliberately
    // non-blocking: health failure pauses learning jobs but never delays or
    // disables Code/Work.
    void learning.startMaintenance().catch((err) => {
      stderrDiagnostics(`learning maintenance start failed: ${err?.message || err}`);
    });

    rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length === 0) return;
      const frame = decodeRaw(line);
      if (!frame) return; // malformed: drop, keep loop alive
      if (frame.type === 'ping') {
        stdout.write(encode({ version: 1, type: 'pong' }));
        stdout.write('\n');
        return;
      }
      if (frame.type === 'pong') return;
      if (frame.type === 'request') {
        handleRequest(frame);
        return;
      }
      // events from parent are ignored (host is authoritative for its topics)
    });

    // Heartbeat ownership (audit §3.2 SH-P0-4): the RUST SHELL pings every
    // 10s and we answer `pong`; it kills us on 30s of silence. Our own
    // outbound ping is therefore off by default — two owners produced a
    // loop where neither side could tell the other was dead. Set
    // TRYLO_SERVICEHOST_SIDECAR_PING=1 to debug the host standalone.
    let ping = null;
    if (process.env.TRYLO_SERVICEHOST_SIDECAR_PING === '1') {
      ping = setInterval(() => {
        try {
          stdout.write(encode({ version: 1, type: 'ping' }));
          stdout.write('\n');
        } catch {
          /* loop may be closing */
        }
      }, PING_INTERVAL_MS);
      ping.unref?.();
    }

    rl.on('close', () => {
      if (ping) clearInterval(ping);
      pet.disable();
      // Bounded flush of the Hermes session queue (spec §7.4: 退出有界 flush).
      // Best effort — a slow adapter must not hold the process open.
      tooling.dispose();
      void Promise.allSettled([
        learning.stopMaintenance(),
        learning.sessionFlush(),
      ]).finally(() => {
        if (autoExit) process.exit(0);
      });
    });
    return this;
  }

  return { start, registry, pet, learning, remote, tooling };
}

// Direct `node src/host.mjs` entry: build a listener with the real stdio.
// pathToFileURL normalizes Windows drive letters/backslashes — a plain
// `file://${argv[1]}` string never matches import.meta.url on win32.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createHost().start();
}
