import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeReviewBackend } from './review-backend.mjs';

const complete = { status: 'completed', answer: 'No durable improvement.', proposals: [], toolFailures: 0 };
const opportunity = (workspaceRoot = 'workspace-a', additions = {}) => ({
  trigger: 'implicit', workspaceRoot, sessionId: 'session', turnId: 'turn',
  taskGoal: 'Prepare a release using the established procedure.', resultSummary: 'A corrected release was prepared.', ...additions,
});
const receipt = (pendingId, name = 'release-procedure', action = 'patch') => ({ pendingId, name, action });
const pendingRecord = (id, target = 'release-procedure', action = 'patch') => ({ id, target, action, subsystem: 'skills' });

function fixture() {
  let data = {}, records = [], availability = true;
  const store = {
    root: 'isolated-storage',
    memento: {
      get(key, fallback) { return key in data ? structuredClone(data[key]) : fallback; },
      async update(key, value) {
        // Separate the caller's read from the commit, as real file IO does.
        await new Promise(resolve => queueMicrotask(resolve));
        data[key] = structuredClone(value);
      },
    },
    compatibility: { async pendingList() { return availability
      ? { ok: true, pending: structuredClone(records) } : { ok: false, pending: [] }; } },
  };
  const backend = createNativeReviewBackend({ loadPrompt: async ({ request }) => ({ success: true, prompt: `Official review guidance. ${request}` }) });
  return { backend, store, setPending(value) { records = value; }, unavailable() { availability = false; } };
}

test('same-skill main and supporting-file receipts remain individual native approvals', async () => {
  const f = fixture(), source = opportunity();
  assert.equal((await f.backend.begin(f.store, source, 'review')).status, 'ready');
  f.setPending([pendingRecord('main', 'release-procedure', 'create'), pendingRecord('reference', 'release-procedure', 'write_file')]);
  const result = await f.backend.finish(f.store, 'review', { ...complete, proposals: [
    receipt('main', 'release-procedure', 'create'), receipt('reference', 'release-procedure', 'write_file'),
  ] });
  assert.deepEqual(result, { status: 'staged', candidateId: 'review', pendingId: 'main', pendingIds: ['main', 'reference'], approval: 'required' });
  f.backend.release(f.store, 'review');
  assert.equal(f.backend.seen(f.store, source), true);
});

test('implicit review preserves confirmed proposals for two distinct relevant skill targets', async () => {
  const f = fixture(), source = opportunity();
  await f.backend.begin(f.store, source, 'review');
  f.setPending([pendingRecord('first'), pendingRecord('reference', 'release-procedure', 'write_file'), pendingRecord('second', 'spreadsheet-procedure')]);
  const result = await f.backend.finish(f.store, 'review', { ...complete, proposals: [
    receipt('first'), receipt('reference', 'release-procedure', 'write_file'), receipt('second', 'spreadsheet-procedure'),
  ] });
  assert.deepEqual(result, { status: 'staged', candidateId: 'review', pendingId: 'first',
    pendingIds: ['first', 'reference', 'second'], approval: 'required' });
  f.backend.release(f.store, 'review');
  assert.equal(f.backend.seen(f.store, source), true);
});

test('explicit learn still rejects multiple primary skill targets', async () => {
  const f = fixture(), source = opportunity('workspace-a', { trigger: 'explicit' });
  await f.backend.begin(f.store, source, 'review');
  f.setPending([pendingRecord('first', 'release-procedure', 'create'), pendingRecord('second', 'spreadsheet-procedure', 'create')]);
  const result = await f.backend.finish(f.store, 'review', { ...complete, proposals: [
    receipt('first', 'release-procedure', 'create'), receipt('second', 'spreadsheet-procedure', 'create'),
  ] });
  assert.equal(result.status, 'failed');assert.equal(result.error, 'hermes_review_unrelated_proposals');
  assert.equal(f.backend.seen(f.store, source), false);
});

test('explicit learn permits one primary skill plus its confirmed supporting-file pending', async () => {
  const f = fixture(), source = opportunity('workspace-a', { trigger: 'explicit' });
  await f.backend.begin(f.store, source, 'review');
  f.setPending([pendingRecord('main', 'release-procedure', 'create'), pendingRecord('reference', 'release-procedure', 'write_file')]);
  const result = await f.backend.finish(f.store, 'review', { ...complete, proposals: [
    receipt('main', 'release-procedure', 'create'), receipt('reference', 'release-procedure', 'write_file'),
  ] });
  assert.deepEqual(result, { status: 'staged', candidateId: 'review', pendingId: 'main', pendingIds: ['main', 'reference'], approval: 'required' });
});

test('pending existence, current target and action must corroborate the observed receipt', async () => {
  for (const mismatch of ['missing', 'target', 'action', 'metadata']) {
    const f = fixture(), source = opportunity();
    await f.backend.begin(f.store, source, 'review');
    f.setPending(mismatch === 'missing' ? [] : [mismatch === 'metadata' ? { id: 'observed', subsystem: 'skills' }
      : pendingRecord('observed', mismatch === 'target' ? 'other-procedure' : 'release-procedure', mismatch === 'action' ? 'delete' : 'patch')]);
    const result = await f.backend.finish(f.store, 'review', { ...complete, proposals: [receipt('observed')] });
    assert.equal(result.status, 'failed', mismatch);
    assert.equal(f.backend.seen(f.store, source), false, mismatch);
  }
});

test('pre-existing and concurrently un-attributed pending records are never claimed by inference', async () => {
  const f = fixture(), source = opportunity();
  f.setPending([pendingRecord('already-pending')]);
  await f.backend.begin(f.store, source, 'review');
  f.setPending([pendingRecord('already-pending'), pendingRecord('concurrent', 'other-procedure')]);
  const result = await f.backend.finish(f.store, 'review', complete);
  assert.deepEqual(result, { status: 'no_learning', candidateId: 'review' });
  assert.equal(f.backend.seen(f.store, source), true, 'a clean empty review does not claim another writer\'s records');
  f.backend.release(f.store, 'review');
  await f.backend.begin(f.store, opportunity('workspace-a', { turnId: 'next-turn' }), 'next');
  const stale = await f.backend.finish(f.store, 'next', { ...complete, proposals: [receipt('already-pending')] });
  assert.equal(stale.status, 'failed');assert.equal(stale.error, 'hermes_review_pending_not_confirmed');
});

test('concurrent workspace stages claim only their own actual receipts without blocking each other', async () => {
  const f = fixture(), first = opportunity('workspace-a'), second = opportunity('workspace-b');
  await f.backend.begin(f.store, first, 'first');await f.backend.begin(f.store, second, 'second');
  f.setPending([pendingRecord('first-pending', 'first-procedure'), pendingRecord('second-pending', 'second-procedure')]);
  const results = await Promise.all([
    f.backend.finish(f.store, 'first', { ...complete, proposals: [receipt('first-pending', 'first-procedure')] }),
    f.backend.finish(f.store, 'second', { ...complete, proposals: [receipt('second-pending', 'second-procedure')] }),
  ]);
  assert.deepEqual(results.map(item => [item.status, item.pendingIds]), [
    ['staged', ['first-pending']], ['staged', ['second-pending']],
  ]);
  f.backend.release(f.store, 'first');f.backend.release(f.store, 'second');
  assert.equal(f.backend.seen(f.store, first), true);assert.equal(f.backend.seen(f.store, second), true);
});

test('recovered tool errors can stage while unconfirmed additional writes remain a partial failure', async () => {
  for (const foreign of [false, true]) {
    const f = fixture(), source = opportunity();await f.backend.begin(f.store, source, 'review');
    f.setPending([pendingRecord('confirmed'), ...(foreign ? [pendingRecord('unobserved', 'other-procedure')] : [])]);
    const result = await f.backend.finish(f.store, 'review', { ...complete, toolFailures: 1, proposals: [receipt('confirmed')] });
    assert.equal(result.status, foreign ? 'failed' : 'staged');assert.deepEqual(result.pendingIds, ['confirmed']);
    f.backend.release(f.store, 'review');
  }
  const f = fixture();await f.backend.begin(f.store, opportunity(), 'incomplete');
  f.setPending([pendingRecord('unobserved')]);
  const failed = await f.backend.finish(f.store, 'incomplete', { ...complete, toolFailures: 1 });
  assert.equal(failed.status, 'failed');assert.equal(f.backend.seen(f.store, opportunity()), false);
});

test('clean no-learning consumes evidence; failed model or tool work remains retryable', async () => {
  for (const execution of [{ ...complete, status: 'failed' }, { ...complete, status: 'cancelled' }, { ...complete, toolFailures: 1 }]) {
    const f = fixture(), source = opportunity();
    await f.backend.begin(f.store, source, 'review');
    const result = await f.backend.finish(f.store, 'review', execution);
    assert.ok(result.status === 'failed' || result.status === 'cancelled', JSON.stringify(result));
    assert.equal(f.backend.seen(f.store, source), false);
    f.backend.release(f.store, 'review');
    assert.equal((await f.backend.begin(f.store, source, 'retry')).status, 'ready');
  }
  const f = fixture(), source = opportunity();
  await f.backend.begin(f.store, source, 'review');
  assert.equal((await f.backend.finish(f.store, 'review', complete)).status, 'no_learning');
  f.backend.release(f.store, 'review');
  assert.deepEqual(await f.backend.begin(f.store, { ...source, trigger: 'explicit' }, 'same-evidence'), { status: 'skipped', reasonCode: 'HASH_PROCESSED' });
});

test('failed execution with a corroborated stage preserves the partial native outcome', async () => {
  const f = fixture(), source = opportunity();
  await f.backend.begin(f.store, source, 'review');
  f.setPending([pendingRecord('partial')]);
  const result = await f.backend.finish(f.store, 'review', { ...complete, status: 'failed', proposals: [receipt('partial')] });
  assert.equal(result.status, 'failed');assert.deepEqual(result.pendingIds, ['partial']);
  f.backend.release(f.store, 'review');
  assert.equal(f.backend.seen(f.store, source), true, 'do not repeat a partially staged improvement as if it never happened');
});

test('overlapping workspace reviews retain both processed sources in the shared memento', async () => {
  const f = fixture(), first = opportunity('workspace-a'), second = opportunity('workspace-b');
  assert.equal((await f.backend.begin(f.store, first, 'first')).status, 'ready');
  assert.equal((await f.backend.begin(f.store, second, 'second')).status, 'ready');
  const results = await Promise.all([f.backend.finish(f.store, 'first', complete), f.backend.finish(f.store, 'second', complete)]);
  assert.deepEqual(results.map(item => item.status), ['no_learning', 'no_learning']);
  f.backend.release(f.store, 'first');f.backend.release(f.store, 'second');
  assert.equal(f.backend.seen(f.store, first), true);
  assert.equal(f.backend.seen(f.store, second), true);
  assert.equal((await f.backend.begin(f.store, first, 'again-first')).reasonCode, 'HASH_PROCESSED');
  assert.equal((await f.backend.begin(f.store, second, 'again-second')).reasonCode, 'HASH_PROCESSED');
});

test('preparation failures release ownership instead of poisoning a workspace lock', async () => {
  let attempts = 0;
  const f = fixture(), backend = createNativeReviewBackend({ loadPrompt: async () => {
    attempts += 1;
    return attempts === 1 ? { success: false } : { success: true, prompt: 'Official review guidance.' };
  } });
  await assert.rejects(backend.begin(f.store, opportunity(), 'first'), /hermes_review_prompt_unavailable/);
  assert.equal((await backend.begin(f.store, opportunity(), 'retry')).status, 'ready');
});

test('failed bookkeeping keeps confirmed pending references and does not poison the next workspace save', async () => {
  const f = fixture(), first = opportunity('workspace-a'), second = opportunity('workspace-b');
  const update = f.store.memento.update;let attempts = 0;
  f.store.memento.update = async (...args) => {
    if (++attempts === 1) throw new Error('SYNTHETIC_PRIVATE_STORAGE_DIAGNOSTIC');
    return update(...args);
  };
  await f.backend.begin(f.store, first, 'first');await f.backend.begin(f.store, second, 'second');
  f.setPending([pendingRecord('confirmed-before-storage-failure')]);
  const [failed, following] = await Promise.all([
    f.backend.finish(f.store, 'first', { ...complete, proposals: [receipt('confirmed-before-storage-failure')] }),
    f.backend.finish(f.store, 'second', complete),
  ]);
  assert.deepEqual(failed, { status: 'failed', candidateId: 'first', error: 'hermes_review_state_save_failed',
    pendingIds: ['confirmed-before-storage-failure'] });
  assert.equal(following.status, 'no_learning');
  assert.equal(f.backend.seen(f.store, first), false);assert.equal(f.backend.seen(f.store, second), true);
  assert.doesNotMatch(JSON.stringify([failed, following]), /SYNTHETIC_PRIVATE_STORAGE_DIAGNOSTIC/);
  f.backend.release(f.store, 'first');f.backend.release(f.store, 'second');
});

test('native pending failure cannot be interpreted as an empty no-learning result', async () => {
  const f = fixture();
  await f.backend.begin(f.store, opportunity(), 'review');
  f.unavailable();
  await assert.rejects(f.backend.finish(f.store, 'review', complete), /hermes_review_pending_unavailable/);
  f.backend.release(f.store, 'review');
});

test('the whole review prompt scrubs quoted JSON credentials while preserving procedural evidence', async () => {
  const f = fixture();
  const source = opportunity('workspace-a', {
    taskGoal: '{"token":"goal-secret-value","task":"retain empty groups"}',
    resultSummary: '{"password":"summary-secret-value","result":"empty groups retained"}',
    learnRequest: '{"api_key":"request-secret-value","focus":"ordered groups"}',
    experience: { messages: [{ role: 'tool_exchange',
      arguments: '{"apiKey":"arguments-secret-value","groupOrder":["A","B"]}',
      output: '{"credentials":{"access_token":"output-secret-value"},"warning":"missing empty group"}',
      text: 'Correction: retain empty groups. Embedded JSON: {"secret":"embedded-secret-value"}',
      metadata: { credentials: { opaque: 'credential-bag-secret-value' }, token: 7239162845,
        authorization: ['credential-array-secret-value'] },
    }] },
  });
  const prepared = await f.backend.begin(f.store, source, 'review');
  assert.equal(prepared.status, 'ready');
  for (const sensitive of ['goal-secret-value', 'summary-secret-value', 'request-secret-value', 'arguments-secret-value', 'output-secret-value',
    'embedded-secret-value', 'credential-bag-secret-value', '7239162845', 'credential-array-secret-value']) {
    assert.equal(prepared.prompt.includes(sensitive), false, sensitive);
  }
  assert.match(prepared.prompt, /retain empty groups/);assert.match(prepared.prompt, /ordered groups/);
  assert.match(prepared.prompt, /groupOrder/);assert.match(prepared.prompt, /missing empty group/);
  assert.match(prepared.prompt, /REDACTED/);
});
