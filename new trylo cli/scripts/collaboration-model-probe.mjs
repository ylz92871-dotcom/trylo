import { artifactPath } from '../../scripts/workspace-paths.mjs';
import { relocatedRecordPath } from '../../scripts/workspace-record-locations.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Three actual provider calls at most. This checks basic tool output only;
// it is explicitly not the ordinary-team or learning-effect acceptance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const build = arg('build-dir') ? relocatedRecordPath(path.resolve(root, arg('build-dir'))) : path.join(root, 'dist');
const model = arg('model') ?? 'Qwen3.8-Flash-Next';
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const previousRoot = arg('resume-probe') === undefined ? undefined : relocatedRecordPath(arg('resume-probe'));
const out = artifactPath('collaboration-model-probe', runId);

mkdirSync(out, { recursive: true });

const load = name => import(pathToFileURL(path.join(build, 'internal', `${name}.js`)).href);
const [{ createCredentialPort }, { createOpenAiCompatibleProvider }, { createWorkspaceTools }, { createWorkspaceSandbox }] = await Promise.all([
  load('adapters/credentials/compose'), load('adapters/provider/openai-compatible'), load('adapters/tools/index'), load('adapters/sandbox/index'),
]);
const save = (name, data) => writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
const previous = previousRoot === undefined ? undefined : JSON.parse(readFileSync(path.join(previousRoot, 'report.json'), 'utf8'));
if (previous !== undefined) save('harness-failure-before-read-policy-fix.json', previous);

const profile = process.env.TRYLO_ACCEPTANCE_HOME ?? path.join(homedir(), '.trylo');
const declared = JSON.parse(readFileSync(path.join(profile, 'providers.json'), 'utf8'));
const connection = declared.providers.find(item => item.id === declared.selected);

assert.equal(connection.kind, 'openai-compatible');

const credential = createCredentialPort({ homeDir: profile, projectDir: root, env: process.env,
  now: () => new Date().toISOString() }).getAccount({ providerId: 'openai-compatible', accountId: connection.accountId });

assert.ok(credential.ok);

const raw = createOpenAiCompatibleProvider({ endpoint: connection.endpoint, model,
  apiKey: credential.value.secret, maxAttemptsBeforeHeaders: 1 });
const provider = raw.fork?.([]) ?? raw;
const sandbox = createWorkspaceSandbox({ workspaceRoot: out });
const tools = createWorkspaceTools({ workspaceRoot: out, sandbox });

writeFileSync(path.join(out, 'source.json'), '{"elapsed":3210}');

const messages = [{ role: 'user', content: 'Read source.json with read_file. Use that tool now. Do not write yet. This is a bounded tool-output conformance task in an isolated workspace.' }];
const report = { mode: 'bounded-tool-conformance-only', model, providerOrigin: new URL(connection.endpoint).origin,
  settingsChanged: false, maximumProviderCalls: 3, calls: [], checks: [], learningEffectAccepted: false,
  ...(previous === undefined ? {} : { resumedProviderCall: 1, priorHarnessFailure: previous.failure }) };

async function request(expectedTool, expectedScale) {
  const callNumber = report.calls.length + 1;

  assert.ok(callNumber <= 3);
  const specs = tools.snapshot().filter(binding => binding.name === expectedTool).map(binding => ({
    name: binding.name, description: binding.description, parameters: binding.parameters,
  }));
  const calls = [];
  const started = Date.now();
  let usage, failure;
  const cached = callNumber === 1 ? previous?.calls[0] : undefined;
  if (cached !== undefined) {
    assert.equal(previous.model, model);
    calls.push(...cached.calls);
    usage = cached.usage;
  } else {
    for await (const event of provider.stream({ attemptId: `probe-${callNumber}`, model, messages, tools: specs,
      maxOutputTokens: 1200 }, AbortSignal.timeout(60000))) {
      if (event.type === 'tool_call') calls.push(event);
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'error') failure = { class: event.class, phase: event.phase, message: event.message };
    }
  }

  const measured = { callNumber, expectedTool, elapsedMs: cached?.elapsedMs ?? Date.now() - started,
    ...(cached === undefined ? {} : { providerRecordReusedWithoutCall: true }), usage: usage ?? { status: 'unreported' },
    calls: calls.map(call => ({ toolCallId: call.toolCallId, name: call.name, arguments: call.arguments })), ...(failure ? { failure } : {}) };

  report.calls.push(measured);
  save(`call-${callNumber}.json`, measured);
  assert.equal(failure, undefined, 'provider returned a typed failure');
  assert.equal(calls.length, 1, 'exactly one requested tool call is required');
  const call = calls[0];

  assert.equal(call.name, expectedTool);
  assert.equal(call.arguments.path, expectedTool === 'read_file' ? 'source.json' : 'mapping.json');

  // The normal loop asks the mutation sandbox for mutating tools. Workspace
  // readers enforce path containment inside their own read-only adapter.
  if (expectedTool === 'write_file') assert.ok(sandbox.evaluate(call).ok, 'the real mutation sandbox must admit the exact target');

  const result = await tools.execute(call, AbortSignal.timeout(10000));

  assert.equal(result.outcome, 'result', 'the actual workspace tool must succeed');
  messages.push({ role: 'assistant', content: '', toolCalls: [{ toolCallId: call.toolCallId, name: call.name, arguments: call.arguments }] });
  messages.push({ role: 'tool', toolCallId: call.toolCallId, content: result.output ?? JSON.stringify(result.value) });

  if (expectedScale === undefined) return;

  const mapping = JSON.parse(readFileSync(path.join(out, 'mapping.json'), 'utf8'));
  const actual = 3210 * mapping.scale;
  const check = { callNumber, mapping, actual, expected: 3210 * expectedScale,
    passed: Object.keys(mapping).length === 3 && mapping.sourceField === 'elapsed'
      && mapping.targetField === 'seconds' && mapping.scale === expectedScale };

  report.checks.push(check);
  save(`check-${callNumber}.json`, check);
  assert.ok(check.passed, 'the independently read mapping must satisfy the exact schema and numeric scale');
}

try {
  await request('read_file');
  messages.push({ role: 'user', content: 'Now create mapping.json using write_file. Exactly three fields: {"sourceField":"elapsed","targetField":"seconds","scale":0.001}. The independent unit specification is milliseconds to seconds, so 3210 must produce 3.21. Do not add fields.' });
  await request('write_file', 0.001);
  messages.push({ role: 'user', content: 'A new upstream handoff explicitly changes the unit scale to 0.01 for this one task. Preserve the sourceField and targetField. Replace mapping.json with exactly {"sourceField":"elapsed","targetField":"seconds","scale":0.01} using write_file; this current handoff supersedes the earlier scale. The independently expected result is 32.1.' });
  await request('write_file', 0.01);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  save('report.json', report);
  console.log(JSON.stringify({ passed: report.passed, model, out, calls: report.calls.length, learningEffectAccepted: false }));
}
