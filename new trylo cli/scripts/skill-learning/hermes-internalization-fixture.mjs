// Helpers for one isolated internalization smoke. No provider network transport.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

export const sha = value => createHash('sha256').update(value).digest('hex');

export function parseArguments(argv) {
  const values = new Map();
  let source = false;

  for (const arg of argv) {
    if (arg === '--source') {
      assert.equal(source, false, '--source must not be repeated');
      source = true;
      continue;
    }
    const match = /^--(build-dir|out)=(.+)$/.exec(arg);
    assert.ok(match && !values.has(match[1]), 'usage: --build-dir=<compiled-root|explicit-source-root> --out=<new-directory> [--source]');
    values.set(match[1], path.resolve(match[2]));
  }

  assert.ok(values.has('build-dir') && values.has('out'), '--build-dir and --out are required');

  return { build: values.get('build-dir'), out: values.get('out'), source };
}

export function within(root, filename) {
  const relative = path.relative(root, path.resolve(filename));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'fixture path escaped out');
}

export function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'isolated evidence tree must not contain symlinks');
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

export function fileState(root, out) {
  return filesUnder(root).sort().map(filename => ({ path: path.relative(out, filename), sha256: sha(readFileSync(filename)) }));
}

export function isolatedEnvironment(paths, python) {
  const environment = {};

  for (const key of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }

  return { ...environment, HERMES_PYTHON: python, TRYLO_NODE_BINARY: process.execPath,
    TRYLO_HOME: paths.profile, TRYLO_HERMES_STORAGE_ROOT: paths.storage,
    APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata, USERPROFILE: paths.home, HOME: paths.home,
    TEMP: paths.temp, TMP: paths.temp, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' };
}

export function fixtureContext(paths, out, environment) {
  let sequence = 0;
  const log = (filename, text) => writeFileSync(path.join(out, filename), text, { flag: 'a' });

  return {
    env: environment, homeDir: paths.home, cwd: paths.workspace, nodeVersion: process.version,
    nodeExecutable: process.execPath, platform: process.platform, stdinIsTty: false,
    now: () => 1_793_721_600_000 + sequence,
    newId: prefix => `${prefix}-internalization-${++sequence}`,
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
    stdout: text => log('runtime-stdout.txt', text), stderr: text => log('runtime-stderr.txt', text),
  };
}

export function nativeToolBody(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value && typeof value === 'object' && typeof value.success === 'boolean') return value;

  for (const item of value?.content ?? []) {
    if (item.type === 'text') return nativeToolBody(item.text);
  }

  if (value?.structuredContent) return nativeToolBody(value.structuredContent);

  throw new Error('actual MCP reply did not contain a native Hermes body');
}

/** Response scripts exercise the real execution loop; they do not simulate skill learning quality. */
export function createSmokeProvider(report, save) {
  let phase;
  let queuedReview;
  const setPhase = value => {
    queuedReview = undefined;
    phase = { ...value, results: new Map() };
    return phase;
  };
  const queueReview = value => {
    queuedReview = { ...value, results: new Map() };
    return queuedReview;
  };
  const provider = () => ({
    fork: () => provider(),
    async *stream(request, signal) {
      assert.ok(phase && !signal.aborted, 'fixture stream must have an active, uncancelled phase');
      const prompt = request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      const visiblePrompt = [request.systemPrompt, request.systemPromptAppend, prompt]
        .filter(value => typeof value === 'string').join('\n');

      // The foreground turn and its automatic funded review share the real
      // provider factory. Switch only when that actual official review arrives.
      if (queuedReview && prompt.includes('TRYLO INTERNAL SKILL REVIEW') && prompt.includes('OBSERVED TASK EXPERIENCE')) {
        phase = queuedReview;
        queuedReview = undefined;
      }

      for (const marker of phase.promptIncludes ?? []) assert.ok(visiblePrompt.includes(marker), `real provider request lost required marker: ${marker}`);

      let action;

      for (const [index, step] of phase.steps.entries()) {
        const id = `internalization-${phase.name}-${index}`;
        const replied = request.messages.findLast(message => message.role === 'tool' && message.toolCallId === id);
        if (replied === undefined) {
          const tool = request.tools.find(item => item.name.endsWith(`__${step.tool}`));
          assert.ok(tool, `actual profile did not mount ${step.tool}`);
          action = { id, name: tool.name, arguments: step.arguments };
          break;
        }

        if (!phase.results.has(id)) {
          const body = nativeToolBody(replied.content);

          assert.equal(body.success, true, `native ${step.tool} failed: ${JSON.stringify(body)}`);

          if (step.staged) {
            assert.equal(body.staged, true);
            assert.ok(typeof body.pending_id === 'string' && body.pending_id);
          }

          if (step.contentIncludes) assert.ok(JSON.stringify(body).includes(step.contentIncludes), `native ${step.tool} returned stale or missing content`);

          phase.results.set(id, { tool: step.tool, arguments: step.arguments, body });
        }
      }

      assert.ok(report.fixtureCalls.length < 24, 'fixture call cap exceeded');
      const usage = { mode: 'snapshot', inputTokens: 32, outputTokens: 16, totalTokens: 48,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

      report.fixtureCalls.push({ phase: phase.name, attemptId: request.attemptId, action: action ? 'tool' : 'final',
        ...(action ? { tool: action.name, arguments: action.arguments } : {}), promptSha256: sha(visiblePrompt), usage,
        metering: 'Deterministic fixture units; not paid-provider metering.' });
      save('report.json', report);
      yield { type: 'stream_start', providerId: 'fixture', model: request.model, warnings: [] };

      if (action) yield { type: 'tool_call', toolCallId: action.id, name: action.name, arguments: action.arguments };
      else {
        yield { type: 'text_start', blockId: 'internalization-answer' };
        yield { type: 'text_delta', blockId: 'internalization-answer', text: phase.answer };
        yield { type: 'text_end', blockId: 'internalization-answer' };
      }

      yield { type: 'usage', usage };
      yield { type: 'finish', reason: action ? 'tool_calls' : 'stop', rawReason: action ? 'tool_calls' : 'stop', requiresFollowUp: Boolean(action) };
    },
  });

  return { provider, setPhase, queueReview };
}
