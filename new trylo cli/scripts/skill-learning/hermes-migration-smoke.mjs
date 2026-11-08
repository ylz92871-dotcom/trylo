// One migration smoke: real Hermes 0.19.0/native files and pending approval,
// with a deterministic ProviderPort. This is not a model/learning benchmark.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--(build-dir|out)=(.+)$/.exec(argument);
  if (!match) throw new Error('usage: --build-dir=<compiled-root> --out=<new-directory>');
  return [match[1], path.resolve(match[2])];
}));

assert.ok(args['build-dir'] && args.out, '--build-dir and --out are required');

assert.ok(!existsSync(args.out), 'out must be new; previous failure evidence is preserved');

mkdirSync(args.out, { recursive: true });

const build = args['build-dir'], out = args.out;
const skillRoot = path.join(build, 'internal', 'learning', 'agent', 'subsystems', 'skill');
const report = {
  kind: 'hermes-mechanism-migration-smoke', status: 'running', buildDir: build,
  paidModelCalls: 0, networkAttempts: 0, providerKind: 'fixture', phases: [], fixtureCalls: [],
  limits: 'Synthetic source and scripted proposals prove migration wiring only; no paid model or learning efficacy acceptance.',
};
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const paths = Object.fromEntries(['home', 'appdata', 'localappdata', 'temp', 'profile', 'workspace', 'hermes-storage']
  .map(name => [name, path.join(out, name)]));

for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });

let runtime;

try {
  assert.ok(existsSync(path.join(skillRoot, 'host', 'worker.mjs')), 'compiled worker is required');
  assert.ok(existsSync(path.join(skillRoot, 'vendor', 'VENDOR-MANIFEST.json')), 'vendor manifest is required');
  report.runtimeHashes = {
    worker: sha(readFileSync(path.join(skillRoot, 'host', 'worker.mjs'))),
    vendorManifest: sha(readFileSync(path.join(skillRoot, 'vendor', 'VENDOR-MANIFEST.json'))),
  };
  const require = createRequire(import.meta.url);
  const resolver = require(path.join(skillRoot, 'vendor', 'legacy', 'hermes-python-resolver.js'));
  // Resolve through the original installed-runtime port before isolating HOME.
  const python = resolver.resolveHermesPython();

  assert.ok(existsSync(python), 'installed Hermes interpreter must exist');
  const environment = isolatedEnvironment(python);

  // MCP's normal child host also reads process.env. Isolate both parent and
  // ctx, so no existing credentials or private Hermes assets enter this run.
  for (const key of Object.keys(process.env)) delete process.env[key];

  Object.assign(process.env, environment);
  globalThis.fetch = async () => {
    report.networkAttempts += 1;
    throw new Error('migration_smoke_network_forbidden');
  };

  const { createHermesSkillRuntime } = await import(pathToFileURL(path.join(build, 'internal', 'surface', 'cli', 'hermes-skill-runtime.js')).href);
  const { workspaceIdentity } = await import(pathToFileURL(path.join(build, 'internal', 'surface', 'cli', 'wiring-catalog.js')).href);
  let sequence = 0, phase, sourceOpportunity;
  const ctx = {
    env: environment, homeDir: paths.home, cwd: paths.workspace, nodeVersion: process.version,
    nodeExecutable: process.execPath, platform: process.platform, stdinIsTty: false,
    now: () => 1_793_692_800_000 + sequence,
    newId: prefix => `${prefix}-migration-${++sequence}`,
    readFile: filename => existsSync(filename) ? readFileSync(filename, 'utf8') : undefined,
    isDirectory: filename => existsSync(filename) && statSync(filename).isDirectory(),
    readDir: directory => existsSync(directory) ? readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }) : [],
    writeFile: (filename, text) => {
      within(out, filename);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, text);
      return true;
    },
    readStdin: async () => '', readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => appendLog('runtime-stdout.txt', text), stderr: text => appendLog('runtime-stderr.txt', text),
  };
  const scaffold = {
    providerId: 'fixture', providerKind: 'fixture', model: 'hermes-migration-fixture', endpoint: '', apiKey: undefined,
    format: 'stream-json', workspaceRoot: paths.workspace, workspaceId: workspaceIdentity(paths.workspace),
    checkpointRoot: path.join(paths.profile, 'checkpoints'), sessionId: 'migration-scaffold', shellIsolation: 'host',
  };
  const providerFactory = () => ({
    fork: () => providerFactory(),
    async *stream(request, signal) {
      assert.ok(!signal.aborted, 'fixture stream cancelled');
      assert.ok(phase, 'runtime must provide an active smoke phase');
      const action = nextFixtureAction(request, phase);
      const usage = { mode: 'snapshot', inputTokens: 32, outputTokens: 16, totalTokens: 48,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
      const call = { phase: phase.action, attemptId: request.attemptId, action: action.kind,
        usageLabel: 'deterministic fixture units, not paid provider metering', usage,
        tools: request.tools.map(tool => tool.name),
        promptHash: sha(request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')),
      };

      if (action.kind === 'tool') Object.assign(call, { toolName: action.name, arguments: action.arguments });

      report.fixtureCalls.push(call);
      save('report.json', report);
      yield { type: 'stream_start', providerId: 'fixture', model: request.model, warnings: [] };

      if (action.kind === 'tool') {
        yield { type: 'tool_call', toolCallId: action.id, name: action.name, arguments: action.arguments };
      } else {
        yield { type: 'text_start', blockId: 'migration-answer' };
        yield { type: 'text_delta', blockId: 'migration-answer', text: 'The skill proposal is staged and awaits approval.' };
        yield { type: 'text_end', blockId: 'migration-answer' };
      }

      yield { type: 'usage', usage };
      yield { type: 'finish', reason: action.kind === 'tool' ? 'tool_calls' : 'stop',
        rawReason: action.kind === 'tool' ? 'tool_calls' : 'stop', requiresFollowUp: action.kind === 'tool' };
    },
  });

  runtime = createHermesSkillRuntime(ctx, scaffold, { provider: providerFactory(), opportunity: async () => sourceOpportunity });
  const profile = await runtime.profile('learning');

  assert.equal(profile.env.TRYLO_MCP_PROFILE, 'learning');
  within(out, profile.env.HERMES_HOME);
  report.profile = { name: profile.name, command: profile.command, args: profile.args, env: profile.env, allowedTools: profile.allowedTools };
  const configuration = readFileSync(path.join(profile.env.HERMES_HOME, 'config.yaml'), 'utf8');

  assert.match(configuration, /skills:\s*\r?\n\s+write_approval: true/);
  report.approvalConfigSha256 = sha(configuration);
  const nativeSkills = path.join(profile.env.HERMES_HOME, 'skills');
  const name = 'migration-smoke-procedure';
  const first = 'Report rows are summarized using the confirmed group order.';
  const updated = 'Report rows are summarized using the confirmed group order and include empty groups.';
  const content = `---\nname: ${name}\ndescription: Summarize synthetic report rows in the requested group order after checking the input fields.\n---\n\n# Synthetic report procedure\n\nUse for the isolated migration fixture with an explicit group order.\n\n1. Read the supplied row fields and confirm the group order.\n2. ${first}\n3. Present the summary and retain the requested order.\n`;

  for (const action of ['create', 'patch']) {
    phase = { action, name, content, first, updated, results: [] };
    const evidence = { action, status: 'running' };

    report.phases.push(evidence);
    const callsBefore = report.fixtureCalls.length;

    sourceOpportunity = {
        trigger: 'explicit', mode: 'agent', workspaceRoot: paths.workspace,
        sessionId: `migration-source-${action}`, turnId: `migration-turn-${action}`,
        taskGoal: `Synthetic migration ${action} phase`,
        resultSummary: action === 'create' ? 'Synthetic rows were grouped in the requested order.' : 'The synthetic request now includes empty groups.',
        learnRequest: action === 'create' ? 'Save the synthetic report procedure as a skill proposal.' : 'Update the same synthetic report procedure to include empty groups.',
        events: [], fileHints: [], verification: [],
      };
    const result = await runtime.learn({ subsystem: 'skill', allowance: { maxCalls: 6, maxOutputTokens: 4096 } },
      new AbortController().signal);

    evidence.learn = result;
    save(`${action}-learn.json`, result);
    save(`${action}-tool-results.json`, phase.results);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.legacyReply?.status, 'staged', JSON.stringify(result));
    const id = result.legacyReply.pendingId;

    assert.ok(typeof id === 'string' && id.length > 0, 'original orchestrator must return a real pending id');
    evidence.pendingId = id;
    assert.equal(result.usage.usageStatus, 'reported');
    const actualCalls = report.fixtureCalls.slice(callsBefore);

    assert.equal(actualCalls.length, 3, 'list, proposal, final must each use the actual execution loop');
    assert.equal(result.usage.calls, 3);
    assert.equal(result.usage.outputTokens, 48);
    assert.equal(result.usage.totalTokens, 144);
    assert.equal(phase.proposedId, id, 'native tool reply and original pending diff must agree');

    const before = skillFiles(nativeSkills);

    assert.equal(before.length, action === 'create' ? 0 : 1, 'proposal must not directly write the native asset');

    if (action === 'patch') assert.equal(readFileSync(before[0], 'utf8').includes(updated), false);

    const detail = await runtime.compatibility('pendingDetail', { subsystem: 'skills', id });

    save(`${action}-pending-detail.json`, detail);
    assert.equal(detail.ok, true, JSON.stringify(detail));
    const expectedHash = detail.detail?.payloadHash;

    assert.ok(typeof expectedHash === 'string' && expectedHash.length > 0, 'approval must bind the reviewed native payload hash');
    const pendingDirectory = path.join(profile.env.HERMES_HOME, 'pending', 'skills');
    const stateBeforeWrongHash = nativeState(nativeSkills, pendingDirectory);
    const wrongHash = `${expectedHash.slice(0, -1)}${expectedHash.endsWith('0') ? '1' : '0'}`;
    const refused = await runtime.compatibility('pendingApply', { subsystem: 'skills', id, expectedHash: wrongHash,
      reason: 'Adversarial hash mismatch in this isolated synthetic fixture; must not apply.' });

    save(`${action}-wrong-hash-apply.json`, refused);
    assert.equal(refused.ok, false, 'a wrong reviewed hash must be refused');
    assert.deepEqual(nativeState(nativeSkills, pendingDirectory), stateBeforeWrongHash,
      'wrong-hash apply must preserve native SKILL.md and pending bytes and identities');
    assert.ok(existsSync(path.join(pendingDirectory, `${id}.json`)), 'refused proposal must remain pending');
    evidence.wrongHashGuard = { rejected: true, nativeAssetsUnchanged: true, pendingUnchanged: true };
    const applied = await runtime.compatibility('pendingApply', { subsystem: 'skills', id, expectedHash,
      reason: 'Explicit approval of this isolated synthetic migration fixture.' });

    save(`${action}-pending-apply.json`, applied);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const viewed = await runtime.compatibility('skillsQuery', { op: 'view', name });

    save(`${action}-skill-view.json`, viewed);
    assert.equal(viewed.ok, true, JSON.stringify(viewed));
    assert.equal(viewed.hermesVersion, '0.19.0');
    assert.ok(JSON.stringify(viewed).includes(action === 'create' ? first : updated), 'actual native view must expose the approved content');
    const files = skillFiles(nativeSkills);

    assert.equal(files.length, 1, 'one native SKILL.md asset must exist');
    const bytes = readFileSync(files[0]);

    assert.ok(bytes.toString('utf8').includes(action === 'create' ? first : updated));
    Object.assign(evidence, { status: 'passed', payloadHash: expectedHash, skillPath: path.relative(out, files[0]), skillSha256: sha(bytes) });
    save('report.json', report);
  }

  assert.notEqual(report.phases[0].pendingId, report.phases[1].pendingId);
  assert.notEqual(report.phases[0].skillSha256, report.phases[1].skillSha256);
  assert.equal(report.networkAttempts, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  if (report.phases.at(-1)?.status === 'running') report.phases.at(-1).status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (runtime) {
    try { await runtime.close(); }
    catch (error) {
      report.closeError = error instanceof Error ? error.message : String(error);
      report.status = 'failed';
      process.exitCode = 1;
    }
  }

  report.fixtureUsage = { calls: report.fixtureCalls.length,
    outputTokens: report.fixtureCalls.reduce((sum, call) => sum + call.usage.outputTokens, 0),
    totalTokens: report.fixtureCalls.reduce((sum, call) => sum + call.usage.totalTokens, 0) };
  save('report.json', report);
  console.log(JSON.stringify({ status: report.status, paidModelCalls: report.paidModelCalls,
    fixtureCalls: report.fixtureCalls.length, phases: report.phases.map(item => ({ action: item.action, status: item.status })), report: path.join(out, 'report.json') }));
}

function isolatedEnvironment(python) {
  const environment = {};

  for (const key of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }

  return { ...environment, HERMES_PYTHON: python, TRYLO_NODE_BINARY: process.execPath,
    TRYLO_HOME: paths.profile, TRYLO_HERMES_STORAGE_ROOT: paths['hermes-storage'],
    APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata, USERPROFILE: paths.home, HOME: paths.home,
    TEMP: paths.temp, TMP: paths.temp, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' };
}

function appendLog(name, text) {
  const filename = path.join(out, name);
  writeFileSync(filename, text, { flag: 'a' });
}

function within(root, filename) {
  const relative = path.relative(root, path.resolve(filename));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'fixture path escaped out');
}

function skillFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    within(out, filename);
    assert.ok(!entry.isSymbolicLink(), 'fixture skill tree must not contain links');
    return entry.isDirectory() ? skillFiles(filename) : entry.name === 'SKILL.md' ? [filename] : [];
  });
}

function nativeState(skillsDirectory, pendingDirectory) {
  return {
    skills: skillFiles(skillsDirectory).sort().map(filename => ({ path: path.relative(out, filename), sha256: sha(readFileSync(filename)) })),
    pending: readdirSync(pendingDirectory).filter(name => name.endsWith('.json')).sort().map(name => {
      const filename = path.join(pendingDirectory, name);
      within(out, filename);
      return { name, sha256: sha(readFileSync(filename)) };
    }),
  };
}

function nativeToolBody(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value && typeof value === 'object' && typeof value.success === 'boolean') return value;

  for (const item of value?.content ?? []) {
    if (item.type === 'text') {
      const parsed = nativeToolBody(item.text);
      if (parsed) return parsed;
    }
  }

  if (value?.structuredContent) return nativeToolBody(value.structuredContent);

  throw new Error('actual MCP tool reply did not contain a native Hermes body');
}

function nextFixtureAction(request, phase) {
  const listId = `migration-${phase.action}-list`, proposeId = `migration-${phase.action}-propose`;
  const list = request.tools.find(tool => tool.name.endsWith('__skills_list'));
  const propose = request.tools.find(tool => tool.name.endsWith('__skill_propose'));

  assert.ok(list && propose, 'actual native learning profile must publish list and propose');
  const reply = id => request.messages.findLast(message => message.role === 'tool' && message.toolCallId === id);
  if (!reply(listId)) return { kind: 'tool', id: listId, name: list.name, arguments: {} };

  const listed = nativeToolBody(reply(listId).content);

  assert.equal(listed.success, true, JSON.stringify(listed));

  if (!reply(proposeId)) {
    assert.ok(propose.parameters.properties.action && propose.parameters.properties.name, 'use the actual native tool schema');
    return { kind: 'tool', id: proposeId, name: propose.name, arguments: phase.action === 'create'
      ? { action: 'create', name: phase.name, content: phase.content }
      : { action: 'patch', name: phase.name, old_string: phase.first, new_string: phase.updated } };
  }

  const staged = nativeToolBody(reply(proposeId).content);

  phase.results = [{ tool: list.name, body: listed }, { tool: propose.name, body: staged }];
  assert.equal(staged.success, true, JSON.stringify(staged));
  assert.equal(staged.staged, true, JSON.stringify(staged));
  phase.proposedId = staged.pending_id ?? staged.pendingId;
  assert.ok(typeof phase.proposedId === 'string' && phase.proposedId, 'native staged reply must provide its pending identity');

  return { kind: 'final' };
}
