#!/usr/bin/env node
// Fault-injecting Anthropic-compatible endpoint for Work daemon E2E tests.
//
// Why this exists: scripts/mock-anthropic-e2e.mjs only ever answers HTTP 200
// with zero latency. It therefore only proves the happy path. Real user
// gateways (rate-limited resale/"compatible" endpoints) also answer 429 and/or
// stall for tens of seconds, and that is exactly where Work hangs.
//
// This gateway can reproduce those failure modes deterministically and logs
// every request/response pair so request amplification and retry backoff can
// be measured instead of guessed.
//
// Env:
//   FAULT_PORT          listen port (default 47842)
//   FAULT_MODE          comma list, evaluated per request, in order:
//      ratelimit:<n>    first <n> requests answer 429 + Retry-After
//      slow:<ms>        every response is delayed by <ms>
//      hang:<n>         request number <n> is accepted and never answered
//      burst:<ms>       any request arriving less than <ms> after the previous
//                       one answers 429 + Retry-After. This is the closest
//                       reproduction of a real resale gateway that reports
//                       "System protection triggered by request burst".
//      normal           (default) answer immediately
//   FAULT_LOG           optional path; append the request log as JSONL

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.env.FAULT_PORT || '47842');
const logPath = process.env.FAULT_LOG || '';

const modes = String(process.env.FAULT_MODE || 'normal')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const t0 = Date.now();
let reqSeq = 0;
const log = [];

function parseCount(spec, prefix) {
  const raw = spec.startsWith(prefix) ? spec.slice(prefix.length) : '';
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

const rateLimitUntil = (() => {
  const m = modes.find((s) => s.startsWith('ratelimit:'));
  return m ? parseCount(m, 'ratelimit:') : 0;
})();
const slowMs = (() => {
  const m = modes.find((s) => s.startsWith('slow:'));
  return m ? parseCount(m, 'slow:') : 0;
})();
const hangAt = (() => {
  const m = modes.find((s) => s.startsWith('hang:'));
  return m ? parseCount(m, 'hang:') : -1;
})();
const burstMs = (() => {
  const m = modes.find((s) => s.startsWith('burst:'));
  return m ? parseCount(m, 'burst:') : 0;
})();
let lastRequestAt = -Infinity;

function emit(entry) {
  const line = JSON.stringify(entry);
  process.stdout.write(`GATEWAY ${line}\n`);
  log.push(entry);
  if (logPath) {
    try {
      appendFileSync(logPath, line + '\n');
    } catch {
      /* ignore */
    }
  }
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function anthropicMessage(content, stopReason = 'end_turn') {
  return {
    id: `msg_fault_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'trylo-fault-model',
    stop_reason: stopReason,
    usage: { input_tokens: 32, output_tokens: 16 },
  };
}

function rateLimitBody() {
  return {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message:
        'System protection triggered by request burst. Please slow down traffic growth and increase requests gradually before retrying.',
    },
  };
}

/** Minimal transcript driver: plan -> tool_use -> final answer. */
function respondTo(body) {
  if (Number(body.max_tokens) <= 64) {
    return anthropicMessage([{ type: 'text', text: '读取项目说明' }]);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some(
    (m) =>
      Array.isArray(m?.content) &&
      m.content.some((b) => b?.type === 'tool_result'),
  );
  if (hasToolResult) {
    return anthropicMessage([{ type: 'text', text: 'FAULT_E2E_OK' }]);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return anthropicMessage(
      [
        {
          type: 'tool_use',
          id: 'toolu_trylo_fault_readme',
          name: 'read_file',
          input: { path: 'README.md', maxChars: 1000 },
        },
      ],
      'tool_use',
    );
  }

  const transcript = JSON.stringify(messages);
  if (!transcript.includes('Create an execution plan.')) {
    return anthropicMessage([{ type: 'text', text: 'FAULT_E2E_OK' }]);
  }

  return anthropicMessage([
    {
      type: 'text',
      text: JSON.stringify({
        description: 'Read-only Work fault E2E',
        steps: [{ id: '1', description: 'Read README.md and report FAULT_E2E_OK' }],
      }),
    },
  ]);
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/messages')) {
    json(res, 404, { error: { message: 'not found' } });
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const n = ++reqSeq;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: { message: 'invalid json' } });
      return;
    }

    const arrivedAt = Date.now();
    const gap = arrivedAt - lastRequestAt;
    lastRequestAt = arrivedAt;
    emit({
      kind: 'request',
      n,
      t: arrivedAt - t0,
      gap: Number.isFinite(gap) ? gap : null,
      maxTokens: body.max_tokens ?? null,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      systemLen:
        typeof body.system === 'string'
          ? body.system.length
          : Array.isArray(body.system)
            ? JSON.stringify(body.system).length
            : 0,
      msgs: Array.isArray(body.messages) ? body.messages.length : 0,
    });

    // hang: accept the request and never answer it.
    if (hangAt === n) {
      emit({ kind: 'hang', n, t: Date.now() - t0 });
      req.socket.setKeepAlive(true);
      return;
    }

    const send = () => {
      if (res.writableEnded) return;
      if (n <= rateLimitUntil || (burstMs > 0 && gap < burstMs)) {
        json(res, 429, rateLimitBody(), { 'retry-after': '2' });
        emit({ kind: 'response', n, status: 429, t: Date.now() - t0, gap });
        return;
      }
      json(res, 200, respondTo(body));
      emit({ kind: 'response', n, status: 200, t: Date.now() - t0 });
    };

    if (slowMs > 0) setTimeout(send, slowMs);
    else send();
  });
});

server.listen(port, '127.0.0.1', () => {
  const summary = { modes, rateLimitUntil, slowMs, hangAt };
  process.stdout.write(
    `FAULT_GATEWAY_READY http://127.0.0.1:${port} ${JSON.stringify(summary)}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
