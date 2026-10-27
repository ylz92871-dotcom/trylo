import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import { settingsDefaults } from '../settings/settings-store';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { createUserLearningRuntime } from '../user-learning/runtime';
import { createUserLearningStore } from '../user-learning/store';
import { startTeamTurn } from '../user-learning/team-access/profiles/host-launch';
import { configureTeamRunsCache } from '../user-learning/team-access/profiles/team-runs-cache';
import { mergeTeamProjection, routeTeamEvents } from '../runtime/team-event-routing';
import type { TeamProfile } from '../surfaces/team/team-profile-types';
import type { TeamRun } from '../surfaces/team/team-types';
import type { CodeRunRequest } from '../runtime/code-run-controller';
import { sendWorkChat } from '../work-chat/work-chat-adapter';
import { sendSubagentInput } from './trylo-v1-subagent-control';
import { CliSessionStore, type CliSessionStorage } from '../runtime/cli-session-store';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
const { CodeRunController } = await import('../runtime/code-run-controller');
const { ConversationRunSupervisor } = await import('../runtime/conversation-run-supervisor');

it.each([
  { name: 'code-complete', surface: 'code', scenario: 'complete' },
  { name: 'work-complete', surface: 'work', scenario: 'complete' },
  { name: 'code-cancel-stream', surface: 'code', scenario: 'cancel' },
  { name: 'work-cad-complete', surface: 'work', scenario: 'cad' },
  { name: 'code-approval-complete', surface: 'code', scenario: 'approval' },
  { name: 'work-approval-complete', surface: 'work', scenario: 'approval' },
  { name: 'code-approval-followup', surface: 'code', scenario: 'approval-followup' },
  { name: 'work-approval-followup', surface: 'work', scenario: 'approval-followup' },
  { name: 'code-owner-admission-complete', surface: 'code', scenario: 'owner-admission' },
  { name: 'code-cancel-refusal', surface: 'code', scenario: 'cancel-refusal' },
  { name: 'code-session-reconstruction', surface: 'code', scenario: 'session-reconstruction' },
] as const)('runs $name through the composer, actual CLI process and origin projection', async ({ name, surface, scenario }) => {
  const workspace = mkdtempSync(join(tmpdir(), 'trylo-team-live-'));
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: join(workspace, '.profile') });
  h.service = service;
  const writes = async (path: string, body: string) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, body); };
  configureTeamRunsCache({ writeFile: writes, readFile: async path => readFileSync(path, 'utf8') });
  const workspaceId = `team-process-${surface}`;
  const writerRole = scenario === 'cad' ? 'cad-planner' : 'worker';
  const reviewerRole = scenario === 'cad' ? 'cad-verifier' : 'reviewer';
  const roles = scenario === 'cad' ? ['person', writerRole, 'worker', reviewerRole] as const
    : ['person', writerRole, reviewerRole] as const;
  const profile: TeamProfile = { schemaVersion: 1, id: 'live', origin: 'custom', surface, title: 'Process team',
    createdAt: 1, updatedAt: 1, members: roles.map(baseRole => ({
      memberId: `m-${baseRole}`, baseRole, displayName: baseRole,
      overlay: { model: baseRole === reviewerRole ? 'review-model' : 'inherit', skills: [], systemPromptOverlay: `TEAM_MEMBER_${baseRole}` },
    })) };
  const learning = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }), now: () => 1000,
    settings: { enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: true, teamAccessEnabled: true } });
  const launch = await startTeamTurn({ workspaceRoot: workspace, workspaceId, conversationId: 'team-proof', product: surface,
    goal: 'TEAM_PARENT', profile, composerLive: true, preparePrompt: learning.preparePrompt,
    isPersonTurnRunning: false, writeFile: writes, newRunId: () => 'team-process-proof' });
  expect(launch.ok).toBe(true);
  if (!launch.ok) return;
  let run = { ...launch.run, workspaceId, selectedSeatId: null } as TeamRun;
  const events: LoopEvent[] = [];
  const agentIds: string[] = [];
  const requests: { model: string; member: string; tools: string[]; toolResults: string[] }[] = [];
  let parentRequests = 0;
  const parentMessages: unknown[] = [];
  let continueParent: (() => void) | undefined;
  const asks = scenario === 'approval' || scenario === 'approval-followup';
  let workerStreamStarted = false;
  let workerStreamClosed = false;
  const outputPath = scenario === 'cad' ? '.trylo/out/cad-plans/probe/construction-package.md'
    : surface === 'work' ? '.trylo/out/worker-result.txt' : 'worker-result.txt';
  const verdictPath = '.trylo/out/cad-plans/probe/verdict.md';
  const personResult = '### Intent\n- explicit: verify actual files\n### Veto\nnone\n### User questions\nnone\n### Representation notes\nRead the isolated fixture workspace.';
  const textReply = (response: ServerResponse, text: string) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  };
  const toolsReply = (response: ServerResponse, calls: { id: string; name: string; arguments: object }[]) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer((incoming, outgoing) => {
    let raw = '';
    incoming.on('data', chunk => { raw += String(chunk); });
    incoming.on('end', () => {
      try {
        const body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
        const child = profile.members.find(member => body.messages.some(message => typeof message.content === 'string'
          && message.content.includes(`TEAM_MEMBER_${member.baseRole}`)));
        if (child) {
          requests.push({ model: body.model, member: child.memberId, tools: body.tools?.map(tool => tool.function.name) ?? [],
            toolResults: body.messages.filter(message => message.role === 'tool').map(message => message.content) });
          if (child.baseRole === 'person') textReply(outgoing, personResult);
          else if (child.baseRole === 'worker' && (scenario === 'cancel' || scenario === 'cancel-refusal')) {
            workerStreamStarted = true;
            outgoing.on('close', () => { workerStreamClosed = true; });
            outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
            // Valid arguments are still undispatched until a tool finish. Stop
            // while the provider holds this response open must never write it.
            outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'never-dispatched',
              type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'worker-result.txt', content: 'MUST_NOT_WRITE' }) } }] }, finish_reason: null }] })}\n\n`);
          } else if (scenario === 'approval-followup' && child.baseRole === writerRole
            && body.messages.some(message => message.role === 'user' && message.content.includes('FOLLOW_UP_REQUIREMENT'))
            && !body.messages.slice(body.messages.map(message => message.role).lastIndexOf('user') + 1).some(message => message.role === 'tool')) {
            toolsReply(outgoing, [{ id: 'worker-write', name: 'write_file', arguments: { path: outputPath, content: 'ACTUAL_WORKER_WRITE_AFTER_FOLLOWUP' } }]);
          } else if (child.baseRole === writerRole && !body.messages.some(message => message.role === 'tool')) {
            toolsReply(outgoing, [{ id: 'worker-write', name: 'write_file', arguments: { path: outputPath, content: 'ACTUAL_WORKER_WRITE' } }]);
          } else if (child.baseRole === 'cad-verifier' && body.messages.filter(message => message.role === 'tool').length < 3) {
            const step = body.messages.filter(message => message.role === 'tool').length;
            const call = step === 0 ? { id: 'refuse-package-edit', name: 'write_file', arguments: { path: outputPath, content: 'MUST_NOT_REPLACE_PACKAGE' } }
              : step === 1 ? { id: 'reviewer-read', name: 'read_file', arguments: { path: outputPath } }
                : { id: 'verdict-write', name: 'write_file', arguments: { path: verdictPath, content: 'VERDICT:PASS' } };
            toolsReply(outgoing, [call]);
          } else if (child.baseRole === reviewerRole && !body.messages.some(message => message.role === 'tool')) {
            toolsReply(outgoing, [{ id: 'reviewer-read', name: 'read_file', arguments: { path: outputPath } }]);
          } else textReply(outgoing, `RESULT_${child.baseRole}`);
          return;
        }
        parentRequests += 1;
        parentMessages.push(body.messages);
        if (parentRequests <= profile.members.length * 2 && parentRequests % 2 === 1) {
          const member = profile.members[Math.floor(parentRequests / 2)]!;
          const respond = () => toolsReply(outgoing, [{ id: `spawn-${member.memberId}`, name: 'spawn_agent',
            arguments: { agent_type: member.baseRole, member_id: member.memberId, message: `TASK_${member.baseRole}` } }]);
          if (scenario === 'approval-followup' && member.baseRole === reviewerRole) continueParent = respond;
          else respond();
        } else if (parentRequests <= profile.members.length * 2) toolsReply(outgoing, [{ id: `wait-${parentRequests}`, name: 'wait_agent',
          arguments: { targets: [agentIds[agentIds.length - 1]], timeout_ms: 1000, release_on_ready: true } }]);
        else if (parentRequests === profile.members.length * 2 + 1) toolsReply(outgoing, agentIds.map((target, index) => ({ id: `close-${index}`, name: 'close_agent', arguments: { target } })));
        else textReply(outgoing, 'TEAM_FINISHED');
      } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local endpoint');
  const permissions = new CodePermissionRegistry({ onChange() {}, send: async (processId, line) => {
    await service.send(processId as Parameters<ProcessService['send']>[0], line); return true;
  } });
  // This fixture exercises the production store/controller/probe/CLI path.
  // The storage port uses isolated real bytes; native atomic/CAS has its own
  // Rust tests rather than being simulated as WebView acceptance here.
  const associationPath = join(workspace, '.trylo', 'runtime-sessions.v1.json');
  const storage: CliSessionStorage = {
    async load() { return existsSync(associationPath) ? readFileSync(associationPath, 'utf8') : null; },
    async save(_root, expected, json) {
      const current = await this.load(workspace);
      if (current !== expected) return { status: 'conflict', current };
      await writes(associationPath, json); return { status: 'written' };
    },
  };
  const durable = scenario === 'session-reconstruction';
  const supervisor = scenario === 'owner-admission' || durable ? new ConversationRunSupervisor({
    ...(durable ? { sessionStore: new CliSessionStore(storage) } : {}),
  }) : null;
  let restored: InstanceType<typeof CodeRunController> | null = null;
  const controller = supervisor?.controller(workspace, 'team-proof')
    ?? new CodeRunController({ projectKey: workspace, conversationId: 'team-proof', permissions, onChange() {} });
  const saveProof = (label = 'process-summary') => {
    if (!process.env.TRYLO_TEAM_PROOF_DIR) return;
    const proofDir = join(process.env.TRYLO_TEAM_PROOF_DIR, name);
    mkdirSync(proofDir, { recursive: true });
    writeFileSync(join(proofDir, `${label}.json`), JSON.stringify({ parentRequests, requests, run, events,
      controller: controller.getViewState(), argv: service.argv,
      workerStreamStarted, workerStreamClosed, forceStops: service.forceStops, wire: service.wire, stderr: service.stderr }, null, 2));
  };
  try {
    const request: CodeRunRequest = { prompt: launch.goal, teamMode: true, surface, turnId: `team-user-turn-${name}`,
      codeMode: 'agent', permissionLevel: asks ? 'ask' : 'workspace_write', priorMessages: [],
      settings: { ...settingsDefaults, systemPrompt: launch.systemPrompt, cliRuntimeProtocol: 'trylo-v1',
        cliPath: resolve(process.env.TRYLO_TEAM_PROOF_CLI ?? '../new trylo cli/dist/cmd/trylo/main.js') as FilePath,
        cliNodeProgram: process.execPath, cwd: workspace, apiFormat: 'openai', apiHost: `http://127.0.0.1:${address.port}/v1`,
        apiModel: 'parent-model', apiKey: 'local-test-only' },
      onEvents: batch => {
        events.push(...batch);
        for (const event of batch) if (event.type === 'subagent' && event.kind === 'spawn') agentIds.push(event.id);
        run = mergeTeamProjection(run, routeTeamEvents({ workspaceId: workspace, personConversationId: 'team-proof' }, batch))!;
      } };
    if (surface === 'work') await sendWorkChat({ runCode: (_project, _conversation, input) => controller.run(input) }, {
      projectKey: workspace, conversationId: 'team-proof', text: request.prompt, settings: request.settings,
      teamMode: true, codeMode: 'agent', permissionLevel: request.permissionLevel, priorMessages: [], onEvents: request.onEvents,
    });
    else if (supervisor) await supervisor.runCode(workspace, 'team-proof', request);
    else await controller.run(request);
    if (asks) {
      await vi.waitFor(() => expect(permissions.list()).toHaveLength(1), { timeout: 20000 });
      const pending = permissions.list()[0]!;
      expect(pending).toMatchObject({ toolName: 'write_file', conversationId: 'team-proof', requester: {
        teamRunId: run.id, memberId: 'm-worker', displayName: 'worker', role: 'worker',
      } });
      expect(existsSync(join(workspace, outputPath))).toBe(false);
      expect(service.argv.flat()).not.toContain('--allow-writes');
      expect(await permissions.respond(pending.requestId, true)).toBe(true);
      if (scenario === 'approval-followup') {
        await vi.waitFor(() => expect(continueParent).toBeTypeOf('function'), { timeout: 20000 });
        const worker = run.seats.find(seat => seat.seat === 'worker')!;
        const processId = controller.getViewState().activeProcessId;
        if (!processId || !worker.taskId) throw new Error('Missing live owner or member task');
        await sendSubagentInput(processId, worker.taskId, 'FOLLOW_UP_REQUIREMENT：继续核对中文内容 🚀', 'append');
        await vi.waitFor(() => expect(permissions.list()).toHaveLength(1), { timeout: 20000 });
        const followup = permissions.list()[0]!;
        expect(followup.requestId).not.toBe(pending.requestId);
        expect(followup.requester?.taskId).toBe(worker.taskId);
        expect(followup.requester?.memberId).toBe('m-worker');
        expect(readFileSync(join(workspace, outputPath), 'utf8')).toBe('ACTUAL_WORKER_WRITE');
        expect(await permissions.respond(followup.requestId, true)).toBe(true);
        await vi.waitFor(() => expect(run.seats.find(seat => seat.taskId === worker.taskId)?.conversation?.length).toBe(2), { timeout: 20000 });
        expect(run.seats.find(seat => seat.taskId === worker.taskId)?.conversation?.[1]?.prompt).toContain('FOLLOW_UP_REQUIREMENT');
        continueParent?.();
      }
    }
    if (scenario === 'cancel' || scenario === 'cancel-refusal') {
      await vi.waitFor(() => expect(workerStreamStarted).toBe(true), { timeout: 20000 });
      if (scenario === 'cancel-refusal') {
        expect(controller.getViewState().runId).not.toBe(request.turnId);
        const nativeStop = service.stop.bind(service);
        const nativeSend = service.send.bind(service);
        const channel = vi.spyOn(service, 'send').mockImplementation(async (id, line) => {
          const frame = JSON.parse(line) as { request?: { subtype?: string } };
          if (frame.request?.subtype === 'interrupt') throw new Error('control channel unavailable');
          await nativeSend(id, line);
        });
        const stop = vi.spyOn(service, 'stop').mockRejectedValueOnce(new Error('native stop refused'));
        try {
          await expect(controller.stop()).rejects.toThrow('native stop refused');
          expect(controller.ownsNativeTurn(request.turnId!)).toBe(true);
          expect(service.children.size).toBe(1);
        } finally { channel.mockRestore(); stop.mockImplementation(nativeStop); }
      }
      await controller.stop();
      if (scenario === 'cancel-refusal') expect(controller.ownsNativeTurn(request.turnId!)).toBe(false);
      await Promise.all(service.exits.values());
      await vi.waitFor(() => expect(workerStreamClosed).toBe(true));
      run = mergeTeamProjection(run, routeTeamEvents({ workspaceId: workspace, personConversationId: 'team-proof', teamRunId: run.id }, [
        { type: 'loop_end', reason: 'cancelled', ts: Date.now() },
      ]))!;
      saveProof();
      expect(existsSync(join(workspace, 'worker-result.txt'))).toBe(false);
      expect(service.children.size).toBe(0);
      expect(controller.getViewState()).toMatchObject({ running: false, activeProcessId: null, error: false });
      expect(run).toMatchObject({ status: 'cancelled', lifecycle: 'closed' });
      return;
    }
    await vi.waitFor(() => expect(events.some(event => event.type === 'loop_end')).toBe(true), { timeout: 20000 });
    await Promise.all(service.exits.values());
    saveProof();
    expect(run.status).toBe('completed');
    expect(run.seats.map(seat => seat.result)).toEqual(profile.members.map(member =>
      member.baseRole === 'person' ? personResult : `RESULT_${member.baseRole}`));
    expect(run.seats.every(seat => seat.status === 'completed')).toBe(true);
    expect(requests.find(request => request.member === `m-${reviewerRole}`)?.model).toBe('review-model');
    if (scenario !== 'cad') expect(requests.find(request => request.member === `m-${reviewerRole}`)?.tools).not.toContain('write_file');
    expect(requests.find(request => request.member === `m-${writerRole}`)?.tools).toContain('write_file');
    expect(requests.some(request => request.member === `m-${reviewerRole}`
      && request.toolResults.some(result => result.includes('ACTUAL_WORKER_WRITE')))).toBe(true);
    expect(readFileSync(join(workspace, outputPath), 'utf8')).toBe(scenario === 'approval-followup'
      ? 'ACTUAL_WORKER_WRITE_AFTER_FOLLOWUP' : 'ACTUAL_WORKER_WRITE');
    if (surface === 'work') expect(existsSync(join(workspace, 'worker-result.txt'))).toBe(false);
    expect(run.seats.find(seat => seat.seat === writerRole)?.activity).toContainEqual(expect.objectContaining({ id: 'worker-write', kind: 'result', ok: true }));
    if (scenario === 'cad') {
      expect(readFileSync(join(workspace, verdictPath), 'utf8')).toBe('VERDICT:PASS');
      expect(requests.some(request => request.member === 'm-cad-verifier'
        && request.toolResults.some(result => result.includes('team_output_scope_denied')))).toBe(true);
      expect(requests.filter(request => request.member !== 'm-person').every(request => !request.tools.includes('run_shell')
        && !request.tools.some(tool => tool.includes('solidworks')))).toBe(true);
    }
    expect(service.children.size).toBe(0);
    if (durable) {
      await vi.waitFor(() => expect(JSON.parse(readFileSync(associationPath, 'utf8')).sessions['team-proof'].state).toBe('established'));
      const initial = JSON.parse(readFileSync(associationPath, 'utf8')).sessions['team-proof'].sessionId as string;
      controller.dispose();
      const fresh = new ConversationRunSupervisor({ sessionStore: new CliSessionStore(storage) });
      restored = fresh.controller(workspace, 'team-proof');
      const before = { parents: parentRequests, children: requests.length, spawnEvents: agentIds.length };
      const resumedEvents: LoopEvent[] = [];
      await fresh.runCode(workspace, 'team-proof', { ...request, prompt: 'VERIFY_RESUMED_CONTEXT',
        turnId: 'team-user-turn-after-reconstruction', onEvents: batch => resumedEvents.push(...batch) });
      await vi.waitFor(() => expect(resumedEvents.some(event => event.type === 'loop_end')).toBe(true), { timeout: 20000 });
      await Promise.all(service.exits.values());
      const argv = service.argv.find(args => args.includes('--resume'));
      expect(argv?.[argv.indexOf('--resume') + 1]).toBe(initial);
      expect(service.argv.some(args => args.includes('session') && args.includes('list') && args.includes('--json'))).toBe(true);
      expect(parentRequests).toBe(before.parents + 1);
      expect(requests).toHaveLength(before.children);
      expect(agentIds).toHaveLength(before.spawnEvents);
      const resumedContext = JSON.stringify(parentMessages.at(-1));
      expect(resumedContext).toContain('TEAM_PARENT');
      expect(resumedContext).toContain('VERIFY_RESUMED_CONTEXT');
      expect(resumedContext).toContain('TEAM_FINISHED');
      expect(resumedContext).toContain('spawn_agent');
      expect(resumedEvents.some(event => event.type === 'text' && (event.fullText ?? event.preview).includes('TEAM_FINISHED'))).toBe(true);
      expect(service.children.size).toBe(0);
      if (process.env.TRYLO_TEAM_PROOF_DIR) writeFileSync(join(process.env.TRYLO_TEAM_PROOF_DIR, name, 'session-reconstruction.json'),
        JSON.stringify({ initial, before, after: { parents: parentRequests, children: requests.length },
          argv: service.argv, parentMessages, resumedEvents }, null, 2));
    }
  } finally {
    saveProof('before-cleanup');
    try { await controller.stop(); }
    finally {
      restored?.dispose(); controller.dispose(); await service.dispose(); configureTeamRunsCache(null);
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      saveProof('after-cleanup');
    }
  }
}, 45000);
