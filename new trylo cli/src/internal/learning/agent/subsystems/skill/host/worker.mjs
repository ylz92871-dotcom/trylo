// JSONL process host for the unchanged Hermes integration. The parent owns
// model execution and permissions; this worker owns no second model loop.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const subsystemRoot = fileURLToPath(new URL('../', import.meta.url));
const capabilitiesDir = path.join(subsystemRoot, 'vendor', 'legacy', 'hermes-capabilities');
// Legacy helpers capture these locations when first required. Configure the
// one internal installation before loading either compatibility or CJS code.
process.env.TRYLO_HERMES_CAPABILITIES_DIR = capabilitiesDir;
process.env.TRYLO_HERMES_SERVER_SCRIPT = path.join(capabilitiesDir, 'server.py');
const require = createRequire(import.meta.url);
const { createFileMemento, createHermesSkillCompatibility } = await import('../compat/index.mjs');

const COMPAT_METHODS = new Set([
  'skillsQuery', 'list', 'view', 'pendingProposeSkill', 'pendingList',
  'pendingDetail', 'pendingApply', 'pendingDiscard', 'pendingBackupList', 'pendingRollback',
]);
const MAX_ACTIVE_REQUESTS = 32;
const MAX_STORAGE_ROOTS = 64;
const MAX_INPUT_CHARS = 4 * 1024 * 1024;
// A read-only internal overlay must coexist with the legacy full-capability service.
const NORMAL_SKILLS_SERVER_NAME = 'trylo-hermes-skills';
const stores = new Map(), activeRequests = new Map(), shadows = new Map();
let reviews;
async function reviewBackend() {
  if (!reviews) reviews = import('./review-backend.mjs').then(module => module.createNativeReviewBackend());
  return reviews;
}
let shadowSequence = 0, inputClosed = false;

class WorkerFailure extends Error {}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function emit(message) {
  if (!inputClosed) process.stdout.write(`${JSON.stringify(message)}\n`);
}
function shortError(error) {
  // Native compatibility failures normally return their original body. A
  // thrown transport/IO exception must not echo prompts or credential values.
  if (error instanceof WorkerFailure) return error.message;
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)) return error.code;
  return 'hermes_worker_operation_failed';
}
function storageFor(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !path.isAbsolute(value)) throw new WorkerFailure('invalid_storage_root');
  const root = path.resolve(value);
  let stored = stores.get(root);
  if (stored) return stored;
  if (stores.size >= MAX_STORAGE_ROOTS) throw new WorkerFailure('worker_storage_limit');
  stored = {
    root,
    memento: createFileMemento({ storageRoot: root, corruptionPolicy: 'fail_closed' }),
    // The legacy UI list default is 2s; cold native imports exceeded it in the
    // real internal fixture. Keep the existing bounded transport, scoped here.
    compatibility: createHermesSkillCompatibility({ storageRoot: root, capabilitiesDir, timeoutMs: 15_000 }),
  };
  stores.set(root, stored);
  return stored;
}

/** Descriptor only: initialize the native data home, never the shared MCP config. */
function profileFor(storageRoot, profile = 'normal', reviewMode = 'implicit', reviewOrigin = 'native') {
  if (profile !== 'learning' && profile !== 'normal') throw new WorkerFailure('unknown_profile');
  if (!['implicit', 'explicit'].includes(reviewMode)) throw new WorkerFailure('unknown_review_mode');
  if (!['native', 'central_research'].includes(reviewOrigin)
    || reviewOrigin === 'central_research' && (profile !== 'learning' || reviewMode !== 'explicit')) throw new WorkerFailure('unknown_review_origin');
  const manager = require('../vendor/legacy/hermes-capability-manager.js');
  const { resolveHermesPython } = require('../vendor/legacy/hermes-python-resolver.js');
  const name = profile === 'learning' ? manager.LEARNING_SERVER_NAME : NORMAL_SKILLS_SERVER_NAME;
  const allowedTools = profile === 'learning' ? manager.LEARNING_ALLOWED_TOOLS.slice()
    : manager.LEARNING_ALLOWED_TOOLS.filter(tool => /__(skills_list|skill_view)$/.test(tool))
      .map(tool => tool.replace(`mcp__${manager.LEARNING_SERVER_NAME}__`, `mcp__${name}__`));
  return {
    name,
    command: resolveHermesPython(),
    args: [path.join(subsystemRoot, 'host', profile === 'learning' ? 'learning-server.py' : 'normal-server.py'),
      '--capabilities-dir', capabilitiesDir, ...(profile === 'learning' ? ['--review-mode', reviewMode] : []),
      ...(reviewOrigin === 'central_research' ? ['--review-origin', reviewOrigin] : [])],
    // Original build* profiles initialize config.yaml here. Keep that native
    // approval gate without calling their shared mcp-config.json writers.
    env: { HERMES_HOME: manager.ensureDataDir(storageRoot), TRYLO_MCP_PROFILE: profile === 'learning' ? 'learning' : '' },
    allowedTools,
  };
}

function cancelRequest(id) {
  const state = activeRequests.get(JSON.stringify(id));
  if (!state) return;
  state.cancelled = true;
  for (const [shadowId, shadow] of shadows) {
    if (shadow.state !== state) continue;
    shadows.delete(shadowId);
    shadow.reject(new WorkerFailure('cancelled'));
  }
}

function runInParent(requestId, storageRoot, prompt, state, reviewMode) {
  if (inputClosed) return Promise.reject(new WorkerFailure('worker_input_closed'));
  if (state.cancelled) return Promise.reject(new WorkerFailure('cancelled'));
  const profile = profileFor(storageRoot, 'learning', reviewMode);
  const shadowId = `shadow:${++shadowSequence}`;
  return new Promise((resolve, reject) => {
    shadows.set(shadowId, { resolve, reject, state });
    emit({ type: 'shadow', id: requestId, shadowId, prompt, profile });
  });
}

function learn(request, store, state) {
  const opportunity = request.opportunity;
  if (!record(opportunity) || !['implicit', 'explicit'].includes(opportunity.trigger)) throw new WorkerFailure('invalid_opportunity');
  const flags = record(opportunity.flags) ? opportunity.flags : {};
  const native = require('../vendor/legacy/learning-loop/orchestrator.js');
  const params = {
    context: { globalState: store.memento },
    globalStoragePath: store.root,
    workspaceRoot: opportunity.workspaceRoot ?? '',
    sessionId: opportunity.sessionId ?? '',
    turnId: opportunity.turnId ?? '',
    mode: opportunity.mode ?? 'agent',
    taskGoal: opportunity.taskGoal ?? '',
    resultText: opportunity.resultSummary ?? '',
    resultSummary: opportunity.resultSummary ?? '',
    events: opportunity.events ?? [],
    fileHints: opportunity.fileHints ?? [],
    verification: opportunity.verification ?? [],
    learnRequest: opportunity.learnRequest ?? '',
    config: opportunity.config ?? {},
    interrupted: flags.interrupted === true,
    hasPendingReview: flags.hasPendingReview === true,
    agentRunning: flags.agentRunning === true,
    iterationsAlreadyApplied: flags.iterationsAlreadyApplied === true,
    reviewResolution: flags.reviewResolution ?? null,
    runInShadow: prompt => runInParent(request.id, store.root, prompt, state, opportunity.trigger),
  };
  return opportunity.trigger === 'explicit' ? native.runExplicitLearn(params) : native.runImplicitReview(params);
}

async function dispatch(request, state) {
  const store = storageFor(request.storageRoot);
  if (request.operation === 'profile') return profileFor(store.root, request.profile, request.reviewMode, request.reviewOrigin);
  if (request.operation === 'review') {
    const reviews = await reviewBackend();
    if (request.action === 'seen') return reviews.seen(store, request.opportunity);
    if (request.action === 'begin') return reviews.begin(store, request.opportunity, String(request.id));
    if (request.action === 'finish') return reviews.finish(store, request.reviewId, request.execution);
    if (request.action === 'release') { reviews.release(store, request.reviewId);return { released: true }; }
    throw new WorkerFailure('unknown_review_operation');
  }
  if (request.operation === 'learn') return learn(request, store, state);
  if (request.operation !== 'compat') throw new WorkerFailure('unknown_operation');
  if (!COMPAT_METHODS.has(request.method)) throw new WorkerFailure('unknown_compat_method');
  const params = request.params;
  // The original view method takes a name; all pending/detail operations
  // retain their original object parameter and original response envelope.
  if (request.method === 'view') return store.compatibility.view(record(params) ? params.name : params);
  return store.compatibility[request.method](params ?? {});
}

async function handleRequest(request) {
  const key = JSON.stringify(request.id);
  if (activeRequests.has(key)) { emit({ type: 'error', id: request.id, error: 'duplicate_request_id' });return; }
  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) { emit({ type: 'error', id: request.id, error: 'worker_request_limit' });return; }
  const state = { cancelled: false };
  activeRequests.set(key, state);
  try {
    const result = await dispatch(request, state);
    // Native compat writes are not rolled back by cancellation. Let them and
    // the original learning finally settle, but never send a stale success.
    if (!state.cancelled) emit({ type: 'result', id: request.id, result });
  } catch (error) {
    if (!state.cancelled) emit({ type: 'error', id: request.id, error: shortError(error) });
  } finally {
    if (state.cancelled && request.operation === 'review' && request.action === 'begin') {
      (await reviewBackend()).release(storageFor(request.storageRoot), String(request.id));
    }
    activeRequests.delete(key);
  }
}

function receive(line) {
  if (line.length > MAX_INPUT_CHARS) { emit({ type: 'error', id: null, error: 'worker_input_limit' });return; }
  let message;
  try { message = JSON.parse(line); }
  catch { emit({ type: 'error', id: null, error: 'invalid_json' });return; }
  if (!record(message)) { emit({ type: 'error', id: null, error: 'invalid_message' });return; }
  if (message.type === 'cancel' && identifier(message.id)) { cancelRequest(message.id);return; }
  if (message.type === 'shadow_result' || message.type === 'shadow_error') {
    const pending = shadows.get(message.shadowId);
    if (!pending) { emit({ type: 'error', id: null, error: 'unknown_shadow_id' });return; }
    shadows.delete(message.shadowId);
    if (message.type === 'shadow_result' && typeof message.answer === 'string') pending.resolve({ answer: message.answer });
    else pending.reject(new WorkerFailure(message.type === 'shadow_error'
      ? (typeof message.error === 'string' && message.error ? message.error.slice(0, 512) : 'parent_shadow_failed')
      : 'invalid_shadow_answer'));
    return;
  }
  if (message.type !== 'request' || !identifier(message.id)) { emit({ type: 'error', id: null, error: 'invalid_request' });return; }
  // Do not await here: a learning request must keep receiving shadow replies,
  // and the original orchestrator owns concurrent-workspace single-flight.
  void handleRequest(message);
}

function closeInput() {
  inputClosed = true;
  for (const pending of shadows.values()) pending.reject(new WorkerFailure('worker_input_closed'));
  shadows.clear();
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', receive);
input.on('close', closeInput);
process.stdin.on('error', closeInput);
process.stdout.on('error', closeInput);
