// One internal end-to-end fixture. Real native mechanisms, zero paid providers.
// Run once at closeout, after staging the current compiled runtime and MJS/Python assets.
// Explicit --source uses current TS through source-loader; pass --experimental-transform-types to Node.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createSmokeProvider, fileState, filesUnder, fixtureContext, isolatedEnvironment, parseArguments, sha, within } from './hermes-internalization-fixture.mjs';

const { build, out, source: sourceMode } = parseArguments(process.argv.slice(2));

assert.ok(!existsSync(out), 'out must be new; preserve previous evidence');

mkdirSync(out, { recursive: true });

const save = (name, value) => writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const paths = Object.fromEntries(['home', 'appdata', 'localappdata', 'temp', 'profile', 'workspace', 'storage'].map(name => [name, path.join(out, name)]));

for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });

const skillRoot = path.join(build, 'internal', 'learning', 'agent', 'subsystems', 'skill');
const report = { kind: 'hermes-internalization-end-to-end-fixture', status: 'running', buildDir: build,
  candidateMode: sourceMode ? 'typescript-source' : 'compiled',
  typeValidation: sourceMode ? 'Behavior check of current TS only; no successful strict compilation is claimed.' : 'Compiled candidate supplied explicitly; this harness does not run the type gate.',
  paidModelCalls: 0, nodeFetchAttempts: 0, fixtureCalls: [], phases: [],
  limitations: 'Scripted ProviderPort proposals prove internal wiring, native staging/approval/reuse/revision only. No autonomous learning efficacy, native Desktop, packaging or real provider acceptance.' };
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort('fixture_deadline'), 180_000);
let runtime, openSession, fixtureHook;
const providerFactoryKey = '__tryloHermesInternalizationFixtureProvider';
const load = filename => import(pathToFileURL(path.join(build, filename)).href);
// The native Windows writer uses CRLF; compare text semantics while retaining
// byte hashes separately for installed-asset revision evidence.
const nativeText = filename => readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');

try {
  if (sourceMode) await import('./source-loader.mjs');

  for (const file of ['host/worker.mjs', 'host/review-backend.mjs', 'host/native-context.py', 'control/dispatch.js']) {
    const required = sourceMode && file.endsWith('.js') ? `${file.slice(0, -3)}.ts` : file;
    assert.ok(existsSync(path.join(skillRoot, required)), `explicit ${report.candidateMode} runtime file missing: ${required}`);
  }

  report.runtimeHashes = Object.fromEntries(['host/worker.mjs', 'host/review-backend.mjs', 'host/native-context.py']
    .map(file => [file, sha(readFileSync(path.join(skillRoot, file)))]));
  const require = createRequire(import.meta.url);
  const python = require(path.join(skillRoot, 'vendor', 'legacy', 'hermes-python-resolver.js')).resolveHermesPython();

  assert.ok(existsSync(python), 'official installed Hermes interpreter is required');
  const sitePackages = path.resolve(path.dirname(python), '..', 'Lib', 'site-packages');

  report.upstreamPromptSourceHashes = Object.fromEntries(['agent/learn_prompt.py', 'agent/background_review.py']
    .filter(file => existsSync(path.join(sitePackages, file))).map(file => [file, sha(readFileSync(path.join(sitePackages, file)))]));
  const environment = isolatedEnvironment(paths, python);

  for (const key of Object.keys(process.env)) delete process.env[key];

  Object.assign(process.env, environment);
  globalThis.fetch = async () => {
    report.nodeFetchAttempts += 1;
    throw new Error('internalization_fixture_fetch_forbidden');
  };
  const fixture = createSmokeProvider(report, save);

  globalThis[providerFactoryKey] = () => fixture.provider();
  const fixtureModules = new Set(['fixture.js', 'fixture.ts'].map(file => pathToFileURL(path.join(build, 'internal/adapters/provider', file)).href));

  // Process-local acceptance hook only. Preserve every other fixture export
  // byte-for-byte, and leave provider construction in the production runtime.
  fixtureHook = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);

    if (!fixtureModules.has(url)) return loaded;

    assert.ok(url.endsWith(sourceMode ? '.ts' : '.js'), 'explicit candidate mode must match the actual loaded fixture adapter');
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    const signature = 'export function createFixtureProvider(';

    assert.equal(source.split(signature).length, 2, 'staged fixture factory signature changed; refuse broad replacement');
    report.testOnlyProviderHook = { target: fileURLToPath(url), candidateMode: report.candidateMode, export: 'createFixtureProvider',
      originalSourceSha256: sha(source), scope: 'This fixture process only; other exports retain their staged source.' };

    return { ...loaded, source: source.replace(signature, 'function originalCreateFixtureProvider(')
      + `\nexport function createFixtureProvider(...args) {\n  const factory = globalThis[${JSON.stringify(providerFactoryKey)}];\n  if (typeof factory !== 'function') throw new Error('fixture_provider_factory_missing');\n  return factory(...args);\n}\n` };
  } });

  const [{ createHermesSkillRuntime }, { workspaceIdentity }, { executeTurn, isTurnFailure }, { createNdjsonSessionStore, recoverSessionRecordView },
    { sessionPath }, { createRunExecution }, { permissionFor }, { hermesProfileRegistry }, { hermesProfileClientFor }, { createBoardReader },
    { runOneTurn }, { parseArgs }, { dispatch: dispatchCommand }] = await Promise.all([
    load('internal/surface/cli/hermes-skill-runtime.js'), load('internal/surface/cli/wiring-catalog.js'), load('internal/surface/cli/host.js'),
    load('internal/adapters/session-store/ndjson.js'), load('internal/surface/cli/session-paths.js'), load('internal/surface/cli/run-execution-wiring.js'),
    load('internal/surface/cli/permission-for-run.js'), load('internal/learning/agent/subsystems/skill/host/mcp-profile.js'),
    load('internal/learning/agent/subsystems/skill/host/mcp-client-for.js'), load('internal/adapters/learning-store/file-event-store.js'),
    load('internal/surface/cli/run-one-turn.js'),
    load('internal/surface/cli/args.js'), load('internal/surface/cli/commands.js'),
  ]);
  const ctx = fixtureContext(paths, out, environment);
  const sessionId = 'hermes-internalization-session', workspaceId = workspaceIdentity(paths.workspace);
  const scaffold = { providerId: 'fixture', providerKind: 'fixture', model: 'hermes-internalization-fixture', endpoint: '', apiKey: undefined,
    format: 'stream-json', workspaceRoot: paths.workspace, workspaceId, checkpointRoot: path.join(paths.profile, 'checkpoints'), sessionId, shellIsolation: 'host' };

  // No opportunity override: both funded reviews recover the canonical journal.
  runtime = createHermesSkillRuntime(ctx, scaffold, { provider: fixture.provider() });

  async function focusThroughCli(input) {
    const callsBefore = report.fixtureCalls.length, outputs = [];
    const cliContext = { ...ctx, readStdin: async () => JSON.stringify(input), stdout: text => outputs.push(text) };

    assert.equal(await dispatchCommand(parseArgs(['learn', 'skill', 'issues', '--json']), cliContext), 0);
    const inspection = JSON.parse(outputs.join(''));
    outputs.length = 0;
    assert.equal(inspection.scope, paths.workspace);
    assert.ok(inspection.issues.some(issue => issue.issueId === input.issueId), 'production inspection must see this runtime source');
    assert.equal(await dispatchCommand(parseArgs(['learn', 'skill', 'focus', '-']), cliContext), 0);
    const result = JSON.parse(outputs.join(''));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.control, 'focus');
    assert.equal(result.issue.scope, paths.workspace);
    assert.equal(result.grant.domain, 'skill');
    assert.equal(report.fixtureCalls.length, callsBefore, 'inspection and explicit allocation must not invoke a model');
    report.centralControlRoute = 'real parseArgs -> generic dispatch -> handleLearn -> skill control -> canonical Board';

    return result;
  }

  const journalFile = sessionPath(paths.home, environment, sessionId);
  const board = createBoardReader(path.join(paths.profile, 'learning', 'board'));
  const name = 'internalization-report-procedure', support = 'references/report-rules.md';
  const first = 'Retain the supplied group order when presenting totals.';
  const revised = 'Retain the supplied group order and include empty groups with a zero total.';
  const supporting = '# Report rules\n\nUse the supplied group-order array. Each requested group appears once.\n';
  const content = `---\nname: ${name}\ndescription: Summarize report rows using a supplied group order and verify all requested groups are represented.\n---\n\n# Report procedure\n\n1. Read the row fields and requested group order.\n2. ${first}\n3. Read [report rules](${support}) when resolving group membership.\n4. Present the summary and identify any uncertainty.\n`;

  async function task(turnId, text, phase, context) {
    fixture.setPhase(phase);
    openSession = createNdjsonSessionStore({ path: journalFile });
    const prior = existsSync(journalFile) ? await openSession.read() : undefined;
    const started = prior === undefined ? await openSession.start({ sessionId, createdAt: new Date(ctx.now()).toISOString(),
      fingerprint: { schemaVersion: '1', providerId: 'fixture', model: scaffold.model, toolCatalogHash: 'fixture-journal', workspaceId } }) : await openSession.attach();

    assert.equal(started.ok, true, JSON.stringify(started));

    if (prior !== undefined) assert.equal(prior.ok, true, JSON.stringify(prior));

    const selection = context?.profile.allowedTools ?? [];
    const execution = createRunExecution(paths.workspace, { homeDir: paths.home, env: environment, shellIsolation: 'host' });

    try {
      const outcome = await executeTurn({ ...scaffold, text, turnId, correlationId: ctx.newId('task'),
        session: openSession, ...(prior?.ok ? { resumeTranscript: prior.session.transcript } : {}),
        permission: permissionFor('non_interactive', ctx, { allowTools: selection }, paths.workspace),
        sink: { stdout: () => {}, stderr: () => {} }, now: ctx.now, cancelSignal: controller.signal,
        systemPrompt: { mode: 'replace', text: 'Execute this isolated synthetic reporting task through the offered tools.' },
        ...(context ? { systemPromptAppend: context.prompt, mcp: { registry: hermesProfileRegistry(context.profile), cwd: paths.workspace,
          clientFor: hermesProfileClientFor(context.profile, undefined, context.observer) } } : {}),
        toolSelection: selection, providerGuard: () => fixture.provider(), execution, maxIterations: 6, maxTokens: 4096 });

      assert.equal(isTurnFailure(outcome), false, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'completed', JSON.stringify(outcome.result));
      save(`${turnId}-transcript.json`, outcome.transcript);

      return outcome;
    } finally {
      await execution.close();
      await openSession.release();
      openSession = undefined;
    }
  }

  async function approve(id, phaseName) {
    const detail = await runtime.compatibility('pendingDetail', { subsystem: 'skills', id });

    assert.equal(detail.ok, true, JSON.stringify(detail));
    const expectedHash = detail.detail?.payloadHash;
    assert.match(expectedHash, /^sha256:[a-f0-9]{64}$/);
    const applied = await runtime.compatibility('pendingApply', { subsystem: 'skills', id, expectedHash,
      reason: 'Explicit approval within the isolated synthetic internalization fixture.' });

    save(`${phaseName}-approval.json`, { pendingId: id, expectedHash, applied });
    assert.equal(applied.ok, true, JSON.stringify(applied));

    return { pendingId: id, payloadHash: expectedHash };
  }

  function installedSkillFile(nativeHome) {
    const files = filesUnder(path.join(nativeHome, 'skills')).filter(file => path.basename(file) === 'SKILL.md'
      && path.basename(path.dirname(file)) === name && !file.includes('.curator_backups'));
    assert.equal(files.length, 1, 'exactly one active native skill is expected');
    within(out, files[0]);
    return files[0];
  }

  await task('source-task', 'Summarize synthetic rows in the supplied group order. The reusable reporting procedure should retain that order.',
    { name: 'source-task', steps: [], answer: 'The synthetic row summary follows the supplied group order.' });
  const sourceRef = `journal:${sessionId}:source-task`;
  const sourceReport = await runtime.coordination.report({ sourceRef, taskId: 'source-task', versionId: sessionId,
    facts: ['The isolated source task reached its visible terminal boundary; this does not assert task quality.'], evidenceRefs: [sourceRef] });

  assert.equal(sourceReport.ok, true, JSON.stringify(sourceReport));
  const initialFocus = await focusThroughCli({ issueId: sourceReport.issue.issueId, expectedRevision: sourceReport.issue.revision,
    reason: 'Explicit fixture allocation for an implicit Hermes review of this observed task.', sourceRefs: [sourceRef],
    allowance: { schemaVersion: 2, unit: 'total_model_tokens', maxTokens: 100_000, maxCalls: 6, maxSteps: 6, maxPromptChars: 100_000 } });

  assert.equal(initialFocus.ok, true, JSON.stringify(initialFocus));
  save('initial-central-focus.json', initialFocus);
  const createPhase = fixture.setPhase({ name: 'learn-create', answer: 'The skill and its linked reference are staged for individual approval.',
    promptIncludes: ['TRYLO INTERNAL SKILL REVIEW', 'OBSERVED TASK EXPERIENCE', 'source-task'], steps: [
      { tool: 'skills_list', arguments: {} },
      { tool: 'skill_propose', arguments: { action: 'create', name, content }, staged: true },
      { tool: 'skill_propose', arguments: { action: 'write_file', name, file_path: support, file_content: supporting }, staged: true },
    ] });
  const created = await runtime.dispatchFunded(controller.signal);

  save('create-learning.json', created);
  save('create-tool-results.json', [...createPhase.results.values()]);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.status, 'completed', JSON.stringify(created));
  const createdPendingRefs = created.result.resultRefs.filter(ref => ref.startsWith('hermes-pending:skills:'));

  assert.equal(createdPendingRefs.length, 2, 'one coherent skill must retain both real pending records');
  const stages = [...createPhase.results.values()].filter(item => item.body.staged);

  assert.deepEqual(new Set(createdPendingRefs), new Set(stages.map(item => `hermes-pending:skills:${item.body.pending_id}`)));
  const learningProfile = await runtime.profile('learning', controller.signal), nativeHome = learningProfile.env.HERMES_HOME;

  within(out, nativeHome);
  assert.equal(filesUnder(path.join(nativeHome, 'skills')).filter(file => path.basename(file) === 'SKILL.md').length, 0,
    'staging must not directly install the asset');
  const approvals = [];

  for (const action of ['create', 'write_file']) {
    const stage = stages.find(item => item.arguments.action === action);
    assert.ok(stage);
    approvals.push(await approve(stage.body.pending_id, action));
  }

  const beforeFile = installedSkillFile(nativeHome), beforeHash = sha(readFileSync(beforeFile));

  assert.equal(nativeText(path.join(path.dirname(beforeFile), support)), supporting);
  report.phases.push({ action: 'implicit-central-create-plus-support', status: 'passed', route: 'manual-lower-runtime-dispatch',
    approvals, grantId: created.grantId, skillSha256: beforeHash });

  const usagePath = path.join(nativeHome, 'skills', '.usage.json');
  const usageBefore = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8'))[name] ?? {} : {};

  assert.equal(usageBefore.created_by, 'agent', 'the implicit create must retain native agent ownership through staging and approval');
  save('ownership-after-create.json', { createdBy: usageBefore.created_by, interpretation: 'Native ownership field, not the broad provenance=agent category.' });
  const normal = await runtime.normalContext(controller.signal);
  assert.ok(normal?.prompt.includes(name), 'normal task must discover the approved skill in its index');
  save('normal-context.json', { promptSha256: sha(normal.prompt), skillIndexed: true });
  await task('skill-use-task', 'Use the installed synthetic report procedure to summarize rows in the requested order.',
    { name: 'skill-use', answer: 'The ordered synthetic report was produced using the loaded skill and reference.', steps: [
      { tool: 'skill_view', arguments: { name }, contentIncludes: first },
      { tool: 'skill_view', arguments: { name, file_path: support }, contentIncludes: 'Each requested group appears once.' },
    ] }, normal);
  assert.ok(existsSync(usagePath), 'actual model-facing read must reach the native usage writer');
  const usageAfter = JSON.parse(readFileSync(usagePath, 'utf8'))[name];

  assert.equal(usageAfter?.view_count, (usageBefore.view_count ?? 0) + 1, 'only instruction loading increments foreground views');
  assert.equal(usageAfter?.use_count, (usageBefore.use_count ?? 0) + 1, 'linked-resource reads must not become extra instruction uses');
  save('usage-after-normal-read.json', { before: usageBefore, after: usageAfter, interpretation: 'Read proxy only; not a verified task success.' });
  report.phases.push({ action: 'normal-index-and-linked-resource', status: 'passed', indexed: true, bodyAndReferenceRead: true });

  await task('correction-task', 'Correction: the report must include empty groups with a zero total, in the same supplied group order.',
    { name: 'correction-task', steps: [], answer: 'The correction is that empty groups require a zero total while preserving group order.' });
  await runtime.reportTask({ sessionId, turnId: 'correction-task' });
  const reported = await board.load();
  assert.equal(reported.ok, true, JSON.stringify(reported));
  const issue = reported.state.learningIssues?.find(item => item.scope === paths.workspace
    && item.reports.some(item => item.source.subsystem === 'skill' && item.source.taskId === 'correction-task'));

  assert.ok(issue, 'a subsequent pure-user correction after a real skill read must become an opportunity fact');
  save('correction-opportunity.json', issue);
  const legacyGrantCount = reported.state.learningGrantFacts?.filter(item => item.kind === 'open').length ?? 0;
  const focused = await focusThroughCli({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: 'Explicit isolated fixture allocation for the observed follow-up after native skill loading.', sourceRefs: issue.reports[0].evidenceRefs,
    allowance: { schemaVersion: 2, unit: 'total_model_tokens', maxTokens: 100_000, maxCalls: 6, maxSteps: 6, maxPromptChars: 100_000 } });

  assert.equal(focused.ok, true, JSON.stringify(focused));
  save('central-focus.json', focused);
  fixture.setPhase({ name: 'daily-bridge-task', promptIncludes: ['<available_skills>', name], steps: [],
    answer: 'The next synthetic reporting task is ready to continue with the supplied correction.' });
  const patchPhase = fixture.queueReview({ name: 'learn-patch', answer: 'The existing skill revision is staged; no second skill was created.',
    promptIncludes: ['OBSERVED TASK EXPERIENCE', 'Correction:', name, 'include empty groups'], steps: [
      { tool: 'learning_graph_summary', arguments: {} },
      { tool: 'skill_view', arguments: { name }, contentIncludes: first },
      { tool: 'skill_propose', arguments: { action: 'patch', name, old_string: first, new_string: revised }, staged: true },
    ] });

  report.dailyBridge = { status: 'prepared', route: 'runOneTurn normalBinding -> mounted-tool index -> foreground terminal -> reportTask -> dispatchFunded',
    fundedIssueId: issue.issueId, fundedGrantId: focused.grant.grantId,
    source: { sessionId, turnId: 'correction-task' }, manualDispatchUsed: false,
    callBudget: 'One foreground call replaces the redundant patch skills_list call; total expected fixture calls remains 16.' };
  save('report.json', report);
  openSession = createNdjsonSessionStore({ path: journalFile });
  const bridgeRecords = await openSession.readRecords();
  assert.equal(bridgeRecords.ok, true, JSON.stringify(bridgeRecords));
  const bridgePrior = recoverSessionRecordView(bridgeRecords.view);
  assert.equal(bridgePrior.ok, true, JSON.stringify(bridgePrior));
  assert.equal((await openSession.attach()).ok, true);
  const bridgeExecution = createRunExecution(paths.workspace, { homeDir: paths.home, env: environment, shellIsolation: 'host' });

  try {
    const bridgeOutcome = await runOneTurn(ctx, { ...scaffold, session: openSession, resumeTranscript: bridgePrior.session.transcript,
      resumeRecords: bridgeRecords.view.records, execution: bridgeExecution, learning: 'skill', maxIterations: 6, maxTokens: 4096,
      close: async () => {} }, 'Continue the synthetic reporting task after the supplied empty-group correction.',
    { stdout: () => {}, stderr: () => {} }, 'non_interactive', {}, controller.signal);

    assert.equal(isTurnFailure(bridgeOutcome), false, JSON.stringify(bridgeOutcome));
    assert.equal(bridgeOutcome.result.status, 'completed', JSON.stringify(bridgeOutcome.result));
    const bridgeTurnId = bridgeOutcome.result.attemptTurnId ?? bridgeOutcome.result.turnId;

    save('daily-bridge-task-transcript.json', bridgeOutcome.transcript);
    const bridgeState = await board.load();
    assert.equal(bridgeState.ok, true, JSON.stringify(bridgeState));
    const autoReport = bridgeState.state.learningIssues?.find(item => item.scope === paths.workspace
      && item.reports.some(row => row.source.subsystem === 'skill' && row.source.taskId === bridgeTurnId));

    assert.ok(autoReport, 'the real runOneTurn terminal must automatically report its canonical task facts');
    const job = bridgeState.state.jobs.find(item => item.jobId === focused.grant.jobId);
    const grant = bridgeState.state.centralLearningGrants.find(item => item.grantId === focused.grant.grantId);

    assert.equal(job?.state, 'succeeded', 'the real daily bridge must consume the already funded correction job');
    assert.equal(grant?.status, 'closed');
    assert.equal(grant?.closedReason, 'completed');
    report.dailyBridge = { ...report.dailyBridge, status: 'passed', foregroundTurnId: bridgeTurnId,
      automaticReportIssueId: autoReport.issueId, jobId: job.jobId, grantStatus: grant.status,
      resultRefs: job.coordination?.resultRefs ?? [] };
    save('central-dispatch.json', { route: 'real-runOneTurn-automatic', ...report.dailyBridge, job, grant });
  } catch (error) {
    report.dailyBridge = { ...report.dailyBridge, status: 'failed', error: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    save('patch-tool-results.json', [...patchPhase.results.values()]);
    save('report.json', report);
    const failureState = await board.load();
    save('daily-bridge-board.json', failureState);
    await bridgeExecution.close();
    await openSession.release();
    openSession = undefined;
  }

  const patch = [...patchPhase.results.values()].find(item => item.arguments.action === 'patch');
  assert.ok(patch);
  assert.deepEqual(report.dailyBridge.resultRefs.filter(ref => ref.startsWith('hermes-pending:skills:')), [`hermes-pending:skills:${patch.body.pending_id}`]);
  assert.equal(sha(readFileSync(beforeFile)), beforeHash, 'pending revision cannot change installed skill before approval');
  const patchApproval = await approve(patch.body.pending_id, 'patch');
  const afterHash = sha(readFileSync(installedSkillFile(nativeHome)));
  assert.notEqual(afterHash, beforeHash);
  assert.equal(nativeText(path.join(path.dirname(beforeFile), support)), supporting);
  const settled = await board.load();
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal(settled.state.centralLearningGrants.filter(item => item.domain === 'skill').length, 2,
    'creation and later correction each retain their explicitly allocated central grant');
  assert.equal(settled.state.learningGrantFacts?.filter(item => item.kind === 'open').length ?? 0, legacyGrantCount, 'central work must not allocate a second legacy output-token grant');
  save('central-final-state.json', { issues: settled.state.learningIssues, grants: settled.state.centralLearningGrants,
    jobs: settled.state.jobs, legacyGrantOpenCount: legacyGrantCount });
  report.phases.push({ action: 'same-session-feedback-central-patch', status: 'passed', approval: patchApproval,
    route: 'real-runOneTurn-automatic', grantId: focused.grant.grantId, beforeSha256: beforeHash, afterSha256: afterHash });

  const nextContext = await runtime.normalContext(controller.signal);
  assert.ok(nextContext?.prompt.includes(name));
  await task('next-task', 'For this next synthetic report, load the current procedure and include empty groups.',
    { name: 'next-task', answer: 'The next report follows the revised procedure, including empty groups with a zero total.', steps: [
      { tool: 'skill_view', arguments: { name }, contentIncludes: revised },
    ] }, nextContext);
  report.phases.push({ action: 'next-task-revised-body', status: 'passed', skillSha256: afterHash });
  report.nativeFiles = fileState(path.join(nativeHome, 'skills'), out);
  assert.equal(report.nodeFetchAttempts, 0);
  assert.equal(report.fixtureCalls.length, 16, 'the real daily bridge must not expand the original fixture call count');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  fixtureHook?.deregister();
  delete globalThis[providerFactoryKey];

  try { await openSession?.release(); }
  catch {
    report.status = 'failed';
    report.sessionCloseError = 'session_release_failed';
    process.exitCode = 1;
  }

  try { await runtime?.close(); }
  catch {
    report.status = 'failed';
    report.closeError = 'runtime_close_failed';
    process.exitCode = 1;
  }

  report.fixtureUsage = { calls: report.fixtureCalls.length, outputTokens: report.fixtureCalls.length * 16, totalTokens: report.fixtureCalls.length * 48 };
  save('report.json', report);
  console.log(JSON.stringify({ status: report.status, candidateMode: report.candidateMode, paidModelCalls: 0, nodeFetchAttempts: report.nodeFetchAttempts,
    fixtureCalls: report.fixtureCalls.length, report: path.join(out, 'report.json') }));
}
