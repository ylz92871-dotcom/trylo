// learning/index.mjs 的方法面与降级（spec §7.5）。纯 Node —— 全部走 seam，
// 不 spawn Python、不要求本机安装 Hermes。

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLearningServices } from '../../src/learning/index.mjs';

const ENV_KEYS = ['TRYLO_APP_DATA_DIR', 'TRYLO_SIDECARS_DIR', 'TRYLO_HERMES_CAPABILITIES_DIR', 'TRYLO_HERMES_SERVER_SCRIPT'];
const SAVED = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
after(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function layout() {
  const appDataDir = mkdtempSync(path.join(tmpdir(), 'learning-app-'));
  const sidecarsDir = mkdtempSync(path.join(tmpdir(), 'learning-side-'));
  return { appDataDir, sidecarsDir };
}

function fakeManager() {
  return {
    tryGetMcpConfigArg: (root) => ({ ok: true, arg: ['--mcp-config', '{}'], warning: null, allowedTools: ['memory_search'], configPath: path.join(root, 'c.json'), hermesHome: path.join(root, 'hermes-capabilities', 'v1') }),
    tryGetLearningMcpConfigArg: (root) => ({ ok: true, arg: ['--mcp-config', '{}'], warning: null, allowedTools: ['memory_manage_init'], configPath: path.join(root, 'l.json'), hermesHome: path.join(root, 'hermes-capabilities', 'v1') }),
    tryGetHistoryMcpConfigArg: (root) => ({ ok: true, arg: ['--mcp-config', '{}'], warning: null, allowedTools: ['history_search'], configPath: path.join(root, 'h.json'), hermesHome: path.join(root, 'hermes-capabilities', 'v1') }),
  };
}

function fakeAdmin() {
  return {
    listPendingAsync: async () => ({ success: true, pending: [], count: 0 }),
    runAdminAsync: async (_root, params) => ({ success: true, params }),
    applySkillWithSnapshotAsync: async (_root, params) => ({ success: true, params }),
    proposeSkillAsync: async () => ({ success: true }),
    listSkillBackupsAsync: async () => ({ success: true, backups: [] }),
    rollbackSkillBackupAsync: async () => ({ success: true }),
  };
}

function fakeSync() {
  return {
    setLogger: () => {},
    mirrorSession: async () => true,
    rebuildIndex: async (sessions) => ({ indexed: sessions.length }),
    shutdown: () => {},
  };
}

function resolvers() {
  return { resolveHermesPython: () => 'C:/hermes/python.exe' };
}

function capabilities() {
  return {
    getHermesHome: (root) => path.join(root, 'hermes-capabilities', 'v1'),
    getServerScriptPath: () => path.join('sidecars', 'hermes-capabilities', 'server.py'),
  };
}

function build(overrides = {}) {
  const { appDataDir, sidecarsDir } = layout();
  return createLearningServices({
    appDataDir,
    sidecarsDir,
    seam: {
      manager: fakeManager(),
      admin: fakeAdmin(),
      sync: fakeSync(),
      resolvers: resolvers(),
      capabilities: capabilities(),
      ...overrides.seam,
    },
    ...overrides.options,
  });
}

test('3A through 3C + L4/L5/L6 method surface is complete', () => {
  const services = build();
  for (const method of [
    'healthCheck',
    'mcpArgsFor',
    'memorySnapshot',
    'skillsQuery',
    'sessionSync',
    'sessionRebuild',
    'sessionFlush',
    'pendingList',
    'pendingDetail',
    'pendingApply',
    'pendingDiscard',
    'pendingBackupList',
    'pendingRollback',
    'pendingProposeSkill',
    'copyTemplateUnderOut',
    'graphSummary',
    'qualityScan',
    'historyMine',
    'jobsManage',
    'startMaintenance',
    'stopMaintenance',
  ]) {
    assert.equal(typeof services[method], 'function', `missing ${method}`);
  }
});

test('env: storage root is <app-data>/Trylo and capabilities come from the sidecars dir', () => {
  const { appDataDir, sidecarsDir } = layout();
  const services = createLearningServices({ appDataDir, sidecarsDir, seam: { sync: fakeSync() } });
  assert.equal(services.env.storageRoot, path.join(appDataDir, 'Trylo'));
  assert.equal(services.env.capabilitiesDir, path.join(sidecarsDir, 'hermes-capabilities'));
  assert.equal(services.env.serverScript, path.join(sidecarsDir, 'hermes-capabilities', 'server.py'));
  assert.equal(services.env.configured, true);
});

test('health: ok when python resolves and server.py exists', async () => {
  const { appDataDir, sidecarsDir } = layout();
  mkdirSync(path.join(sidecarsDir, 'hermes-capabilities'), { recursive: true });
  writeFileSync(path.join(sidecarsDir, 'hermes-capabilities', 'server.py'), '# hermes\n', 'utf8');

  const services = createLearningServices({
    appDataDir,
    sidecarsDir,
    seam: { resolvers: resolvers(), capabilities: capabilities(), sync: fakeSync() },
  });
  const health = await services.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.serverScriptFound, true);
  assert.equal(health.pythonExe, 'C:/hermes/python.exe');
  assert.equal(health.hermesHome, path.join(appDataDir, 'Trylo', 'hermes-capabilities', 'v1'));
});

test('health: missing server.py is reported with a reason (no throw)', async () => {
  const { appDataDir, sidecarsDir } = layout();
  const services = createLearningServices({
    appDataDir,
    sidecarsDir,
    seam: { resolvers: resolvers(), capabilities: capabilities(), sync: fakeSync() },
  });
  const health = await services.healthCheck();
  assert.equal(health.ok, false);
  assert.equal(health.serverScriptFound, false);
  assert.match(health.reason, /server script not found/);
});

test('health: unresolvable python carries the install hint', async () => {
  const services = build({
    seam: { resolvers: { resolveHermesPython: () => { throw new Error('Could not run uv tool dir'); } } },
  });
  const health = await services.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.reason, /uv tool dir/);
  assert.match(health.installHint, /install hermes-agent/);
});

test('mcpArgs delegates to the vendored profiles', async () => {
  const services = build();
  for (const profile of ['normal', 'learning', 'history']) {
    const result = await services.mcpArgsFor({ profile });
    assert.equal(result.ok, true);
    assert.equal(result.profile, profile);
    assert.ok(result.allowedTools.length > 0);
  }
});

test('skills op dispatch: list / view / unsupported', async () => {
  const services = build();
  const bad = await services.skillsQuery({ op: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unsupported skills op/);

  // list/view 需要 Hermes Python；本机未安装时降级为 ok:false，绝不抛错。
  const listed = await services.skillsQuery({ op: 'list' });
  assert.equal(typeof listed.ok, 'boolean');
});

test('pending: apply without expectedHash is rejected (fail closed)', async () => {
  const services = build();
  await assert.rejects(
    () => services.pendingApply({ subsystem: 'skills', id: 'p1' }),
    (err) => err.code === 'MISSING_HASH',
  );
  const ok = await services.pendingApply({ subsystem: 'skills', id: 'p1', expectedHash: 'sha256:abc' });
  assert.equal(ok.ok, true);
});

test('pending: list / detail / discard / backups / rollback all resolve', async () => {
  const services = build();
  assert.equal((await services.pendingList()).ok, true);
  assert.equal((await services.pendingDetail({ subsystem: 'skills', id: 'p1' })).ok, true);
  assert.equal((await services.pendingDiscard({ subsystem: 'skills', id: 'p1' })).ok, true);
  assert.equal((await services.pendingBackupList()).ok, true);
  assert.equal((await services.pendingRollback({ snapshotId: 'snap-1' })).ok, true);
});

test('session: sync / rebuild / flush all resolve', async () => {
  const services = build();
  assert.deepEqual(
    await services.sessionSync({ session: { id: 's1', turns: [] } }),
    { ok: true, mirrored: true },
  );
  assert.deepEqual(await services.sessionRebuild({ sessions: [{ id: 's1' }] }), { ok: true, result: { indexed: 1 } });
  assert.deepEqual(await services.sessionFlush(), { ok: true, stopped: true });
});

test('session mirror feeds the scheduled rebuild snapshot', async () => {
  const rebuilt = [];
  const sync = fakeSync();
  sync.rebuildIndex = async (sessions) => {
    rebuilt.push(sessions);
    return { indexed: sessions.length };
  };
  const { appDataDir, sidecarsDir } = layout();
  mkdirSync(path.join(sidecarsDir, 'hermes-capabilities'), { recursive: true });
  writeFileSync(path.join(sidecarsDir, 'hermes-capabilities', 'server.py'), '# hermes\n', 'utf8');
  const services = createLearningServices({
    appDataDir,
    sidecarsDir,
    seam: {
      manager: fakeManager(),
      admin: fakeAdmin(),
      sync,
      resolvers: resolvers(),
      capabilities: capabilities(),
    },
  });
  await services.sessionSync({ session: { id: 's1', title: 'first', turns: [] } });
  await services.sessionSync({ session: { id: 's1', title: 'updated', turns: [] } });
  await services.jobsManage({
    action: 'register', jobId: 'scheduled-rebuild', type: 'index-rebuild',
    intervalMs: 60_000, enabled: false,
  });
  const run = await services.jobsManage({ action: 'runNow', jobId: 'scheduled-rebuild' });
  assert.equal(run.ok, true);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].length, 1);
  assert.equal(rebuilt[0][0].title, 'updated');
  await services.stopMaintenance();
});

test('unconfigured shell: read-only queries degrade instead of throwing', async () => {
  const services = createLearningServices({ appDataDir: '', sidecarsDir: '', seam: { sync: fakeSync() } });
  const health = await services.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.reason, /storage root is not configured/);

  const snapshot = await services.memorySnapshot();
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.error, /storage root is not configured/);

  const mcp = await services.mcpArgsFor({ profile: 'normal' });
  assert.equal(mcp.ok, false);
});

test('memento is exposed for the 3C learning loop (legacy state key only)', async () => {
  const services = build();
  assert.equal(typeof services.memento.get, 'function');
  assert.equal(typeof services.memento.update, 'function');
  await services.memento.update('tryloCode.learning.state', { version: 1 });
  assert.deepEqual(await services.memento.get('tryloCode.learning.state'), { version: 1 });
});
