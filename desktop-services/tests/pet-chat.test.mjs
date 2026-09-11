// Trylo Desktop Services — pet chat behavior tests (migration spec §6.4).
//
// Characterizes the extracted chat pipeline against the legacy behavior:
// message names, limit constants, single-flight, cancel copy, history
// persistence, and the explicit Fun (猫箱) rejection (legacy fun cases are
// replaced by "assert explicit refusal" per spec §6.4). The LLM endpoints
// are a local mock server speaking the OpenAI / Anthropic SSE dialects;
// expectations come from the legacy request code, not from this repo's new
// implementation. node:test only (spec §0 rule 5).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  DESKTOP_CHAT_LIMITS,
  desktopChatSystemPrompt,
  sanitizeDesktopChatMessages,
  shortText,
} from '../src/pet-chat/chat-limits.mjs';
import { createChatStore, desktopChatStorageFilePath } from '../src/pet-chat/chat-store.mjs';
import { createDesktopChatCommand } from '../src/pet-chat/chat-command.mjs';
import { createPetChat } from '../src/pet-chat/index.mjs';
import { createHost } from '../src/host.mjs';
import { Writable, Readable } from 'node:stream';

const short = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collects `respond()` outputs from the chat command with consume-based
 *  waiting keyed by message type. */
function createEmitCollector() {
  const messages = [];
  return {
    messages,
    async waitFor(type, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find((m) => m.type === type && !m.claimed);
        if (found) {
          found.claimed = true;
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error(`chat message '${type}' not emitted within ${timeoutMs}ms; got: ${messages.map((m) => m.type).join(',')}`);
        }
        await short(10);
      }
    },
  };
}

// ── local mock LLM server (OpenAI + Anthropic SSE dialects) ──────────

function createMockLlmServer() {
  const state = { lastRequest: null, hang: false, pending: [] };

  const respond = (req, res) => {
    const url = req.url || '';
    if (url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { input_tokens: 5, output_tokens: 2 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (url.endsWith('/messages')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-mock', usage: { input_tokens: 7 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bonjour' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 3 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(body || '{}');
      } catch {
        // leave {}
      }
      state.lastRequest = { url: req.url, headers: req.headers, body: parsedBody };
      if (state.hang) {
        // The client may abort (cancel path) before release(); swallow the
        // write-after-disconnect error so the runner never crashes.
        res.on('error', () => {});
        state.pending.push({ req, res });
        return;
      }
      respond(req, res);
    });
  });
  return {
    state,
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    },
    port() {
      return server.address().port;
    },
    release() {
      for (const { req, res } of state.pending.splice(0)) respond(req, res);
      state.hang = false;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── chat-limits (pure) ───────────────────────────────────────────────

describe('pet-chat: chat-limits', () => {
  it('pins the legacy limit constants', () => {
    assert.deepEqual(DESKTOP_CHAT_LIMITS, { maxMessages: 80, maxContextMessages: 36, maxMessageChars: 16000 });
  });

  it('shortText truncates beyond the cap with an ellipsis', () => {
    assert.equal(shortText('abc', 5), 'abc');
    assert.equal(shortText('abcdef', 5), 'abcde...');
  });

  it('sanitize keeps user/assistant turns, truncates, drops empties, pins the tail', () => {
    const long = 'x'.repeat(DESKTOP_CHAT_LIMITS.maxMessageChars + 10);
    const input = [
      { role: 'system', text: 'nope' },
      { role: 'user', text: '  ' },
      { role: 'user', text: 'hello', at: 1 },
      { role: 'assistant', text: long, at: 2 },
    ];
    const out = sanitizeDesktopChatMessages(input);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, 'hello');
    assert.equal(out[1].text.length, DESKTOP_CHAT_LIMITS.maxMessageChars + 3); // cap + '...'
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
    assert.equal(sanitizeDesktopChatMessages('not an array').length, 0);
  });

  it('system prompt keeps the CHAT ONLY boundary and optional personality', () => {
    const prompt = desktopChatSystemPrompt({ systemPrompt: 'Be concise.' });
    assert.match(prompt, /CHAT ONLY/);
    assert.match(prompt, /main Trylo page/);
    assert.match(prompt, /Be concise\./);
    const bare = desktopChatSystemPrompt({});
    assert.match(bare, /CHAT ONLY/);
    assert.doesNotMatch(bare, /optional personality and response-style guidance only:\n\S/);
  });
});

// ── chat-store ───────────────────────────────────────────────────────

describe('pet-chat: chat-store', () => {
  it('stores history under <appData>/Trylo/companion/desktop-chat.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-pet-chat-'));
    const store = createChatStore(root);
    assert.equal(store.filePath, desktopChatStorageFilePath(root));
    assert.match(store.filePath, /Trylo[\\/]companion[\\/]desktop-chat\.json$/);

    assert.deepEqual(await store.read(), []); // missing file → []
    await store.write([{ role: 'user', text: 'hi', at: 1 }]);
    const raw = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.messages.length, 1);
    assert.deepEqual(await store.read(), [{ role: 'user', text: 'hi', at: 1 }]);

    await fs.writeFile(store.filePath, '{broken json', 'utf8');
    assert.deepEqual(await store.read(), []); // corrupt file → [] (legacy semantics)

    assert.equal(createChatStore('').filePath, '');
  });
});

// ── chat-command over the real LLM client (mock server) ─────────────

describe('pet-chat: chat-command', () => {
  const llm = createMockLlmServer();
  let root = '';
  let store = null;

  const openAiConfig = () => ({
    endpoint: `http://127.0.0.1:${llm.port()}/v1`,
    apiKey: 'sk-test',
    apiKeyHeader: 'authorization',
    apiKeyPrefix: 'Bearer ',
    apiFormat: 'openai',
    model: 'mock-openai-model',
    extraHeadersText: '{}',
  });
  const anthropicConfig = () => ({
    endpoint: `http://127.0.0.1:${llm.port()}/v1`,
    apiKey: 'sk-test',
    apiKeyHeader: 'x-api-key',
    apiKeyPrefix: '',
    apiFormat: 'anthropic',
    model: 'mock-anthropic-model',
    extraHeadersText: '{}',
  });

  before(async () => {
    await llm.listen();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-pet-chat-cmd-'));
    store = createChatStore(root);
  });

  after(async () => {
    await llm.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('explicitly rejects Fun and unknown modes (猫箱不迁，显式拒绝)', async () => {
    const handle = createDesktopChatCommand({ store });
    for (const mode of ['fun', 'agent']) {
      const emit = createEmitCollector();
      await handle({ type: 'chat_send', requestId: `r-${mode}`, mode, text: 'hi' }, (m) => emit.messages.push(m));
      const err = await emit.waitFor('chat_error');
      assert.equal(err.mode, mode);
      assert.equal(err.error, '本版本不支持猫箱(Fun)模式。');
    }
  });

  it('chat_send streams chat_started → chat_delta(sequence) → chat_complete and persists history (OpenAI)', async () => {
    const handle = createDesktopChatCommand({ store });
    const emit = createEmitCollector();
    await handle({ type: 'chat_send', requestId: 'r-1', mode: 'chat', text: '  hi  ' }, (m) => emit.messages.push(m), openAiConfig());

    const started = await emit.waitFor('chat_started');
    assert.equal(started.requestId, 'r-1');
    const d1 = await emit.waitFor('chat_delta');
    assert.equal(d1.sequence, 1);
    assert.equal(d1.delta, 'Hel');
    const d2 = await emit.waitFor('chat_delta');
    assert.equal(d2.sequence, 2);
    assert.equal(d2.delta, 'lo');
    const done = await emit.waitFor('chat_complete');
    assert.equal(done.requestId, 'r-1');
    assert.equal(done.text, 'Hello');

    // OpenAI wire shape: system prompt + bounded history + model + auth header.
    const req = llm.state.lastRequest;
    assert.ok(req.url.endsWith('/v1/chat/completions'));
    assert.equal(req.body.model, 'mock-openai-model');
    assert.equal(req.body.stream, true);
    assert.match(req.headers.authorization, /^Bearer sk-test$/);
    const system = req.body.messages.find((m) => m.role === 'system');
    assert.match(system.content, /CHAT ONLY/);
    const lastMessage = req.body.messages[req.body.messages.length - 1];
    assert.equal(lastMessage.content, 'hi');

    const persisted = await store.read();
    assert.deepEqual(
      persisted.map((m) => [m.role, m.text]),
      [['user', 'hi'], ['assistant', 'Hello']],
    );
  });

  it('chat_send works over the Anthropic dialect (system + x-api-key + anthropic-version)', async () => {
    const handle = createDesktopChatCommand({ store });
    const emit = createEmitCollector();
    await handle({ type: 'chat_send', requestId: 'r-2', mode: 'chat', text: 'salut' }, (m) => emit.messages.push(m), anthropicConfig());
    const done = await emit.waitFor('chat_complete');
    assert.equal(done.text, 'Bonjour');

    const req = llm.state.lastRequest;
    assert.ok(req.url.endsWith('/v1/messages'));
    assert.equal(req.body.model, 'mock-anthropic-model');
    assert.equal(req.headers['x-api-key'], 'sk-test');
    assert.ok(req.headers['anthropic-version']);
  });

  it('rejects an empty message without touching the LLM', async () => {
    const handle = createDesktopChatCommand({ store });
    const emit = createEmitCollector();
    await handle({ type: 'chat_send', requestId: 'r-3', mode: 'chat', text: '   ' }, (m) => emit.messages.push(m), openAiConfig());
    const err = await emit.waitFor('chat_error');
    assert.equal(err.error, 'Message is empty.');
    assert.equal(err.requestId, 'r-3');
  });

  it('fails closed with a config error when the endpoint is missing', async () => {
    const handle = createDesktopChatCommand({ store });
    const emit = createEmitCollector();
    await handle({ type: 'chat_send', requestId: 'r-4', mode: 'chat', text: 'hi' }, (m) => emit.messages.push(m), {});
    const err = await emit.waitFor('chat_error');
    assert.match(err.error, /API endpoint is missing/);
  });

  it('enforces single-flight while a reply is streaming', async () => {
    const handle = createDesktopChatCommand({ store });
    llm.state.hang = true;
    const firstEmit = createEmitCollector();
    const inFlight = handle({ type: 'chat_send', requestId: 'r-5', mode: 'chat', text: 'one' }, (m) => firstEmit.messages.push(m), openAiConfig());
    await firstEmit.waitFor('chat_started');

    const secondEmit = createEmitCollector();
    await handle({ type: 'chat_send', requestId: 'r-6', mode: 'chat', text: 'two' }, (m) => secondEmit.messages.push(m), openAiConfig());
    const busy = await secondEmit.waitFor('chat_error');
    assert.equal(busy.error, 'Trylo is already replying in the desktop chat.');

    llm.release();
    await inFlight;
    await firstEmit.waitFor('chat_complete');
  });

  it('chat_cancel aborts the in-flight reply with the legacy copy', async () => {
    const handle = createDesktopChatCommand({ store });
    llm.state.hang = true;
    const emit = createEmitCollector();
    const inFlight = handle({ type: 'chat_send', requestId: 'r-7', mode: 'chat', text: 'slow' }, (m) => emit.messages.push(m), openAiConfig());
    await emit.waitFor('chat_started');
    await handle({ type: 'chat_cancel', requestId: 'r-7', mode: 'chat' }, (m) => emit.messages.push(m));
    const err = await emit.waitFor('chat_error', 4000);
    assert.equal(err.requestId, 'r-7');
    assert.equal(err.error, '已停止本次回复。');
    llm.release();
    await inFlight;
  });

  it('chat_clear aborts, wipes history and answers chat_cleared', async () => {
    const handle = createDesktopChatCommand({ store });
    llm.state.hang = true;
    const emit = createEmitCollector();
    const inFlight = handle({ type: 'chat_send', requestId: 'r-8', mode: 'chat', text: 'clear me' }, (m) => emit.messages.push(m), openAiConfig());
    await emit.waitFor('chat_started');
    await handle({ type: 'chat_clear', requestId: '', mode: 'chat' }, (m) => emit.messages.push(m));
    const cleared = await emit.waitFor('chat_cleared');
    assert.ok(cleared);
    assert.deepEqual(await store.read(), []);
    llm.release();
    await inFlight;
  });

  it('chat_history_request returns the persisted (sanitized) history', async () => {
    const seeded = createChatStore(await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-pet-chat-hist-')));
    await seeded.write([{ role: 'user', text: 'older', at: 1 }, { role: 'assistant', text: 'answer', at: 2 }]);
    const handle = createDesktopChatCommand({ store: seeded });
    const emit = createEmitCollector();
    await handle({ type: 'chat_history_request', requestId: 'r-9', mode: 'chat' }, (m) => emit.messages.push(m));
    const history = await emit.waitFor('chat_history');
    assert.deepEqual(
      history.messages.map((m) => m.text),
      ['older', 'answer'],
    );
  });
});

// ── host contract: pet.chatHandle is registered; chat config is optional ──

describe('pet-chat: host method surface', () => {
  it('registers pet.chatHandle; without a live chat session it reports no-session', async () => {
    let out = '';
    const input = new Readable({ read() {} });
    const output = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const host = createHost({ stdin: input, stdout: output, stderr: output, autoExit: false });
    host.start();
    input.push(`${JSON.stringify({ version: 1, type: 'request', id: 'ch1', method: 'pet.chatHandle', params: { message: { type: 'chat_send', requestId: 'x', mode: 'chat', text: 'hi' } } })}\n`);
    const deadline = Date.now() + 1000;
    let response = null;
    while (Date.now() < deadline && !response) {
      const frames = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      response = frames.find((f) => f && f.type === 'response' && f.id === 'ch1') || null;
      if (!response) await short(10);
    }
    assert.ok(response, 'no response for pet.chatHandle');
    assert.equal(response.ok, true); // request was handled at the frame level
    assert.equal(response.result.ok, false); // ...but no live chat session exists
    assert.match(response.result.error, /no active companion chat session/);
    input.push(null);
  });
});

// ── module factory smoke ─────────────────────────────────────────────

describe('pet-chat: factory', () => {
  it('createPetChat wires a store and handler bound to the app-data root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-pet-chat-factory-'));
    const petChat = createPetChat({ appDataDir: root });
    assert.match(petChat.store.filePath, /desktop-chat\.json$/);
    const emit = createEmitCollector();
    await petChat.handle({ type: 'chat_history_request', requestId: 'f1', mode: 'chat' }, (m) => emit.messages.push(m), {});
    const history = await emit.waitFor('chat_history');
    assert.deepEqual(history.messages, []);
  });
});
