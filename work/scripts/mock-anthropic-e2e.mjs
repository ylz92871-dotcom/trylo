#!/usr/bin/env node

// Deterministic local Anthropic-compatible endpoint for Work daemon E2E tests.
// It exercises plan creation, a real read_file tool round-trip, the optional
// tool-batch summary call, and the final assistant answer without depending on
// an external provider. It never writes to the tested workspace.

import { createServer } from 'node:http';

const port = Number(process.env.TRYLO_E2E_LLM_PORT || '47841');

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function anthropicMessage(content, stopReason = 'end_turn') {
  return {
    id: `msg_e2e_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'trylo-e2e-model',
    stop_reason: stopReason,
    usage: { input_tokens: 32, output_tokens: 16 },
  };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/messages')) {
    json(res, 404, { error: { message: 'not found' } });
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: { message: 'invalid json' } });
      return;
    }

    if (Number(body.max_tokens) <= 64) {
      json(res, 200, anthropicMessage([{ type: 'text', text: '读取项目说明' }]));
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasToolResult = messages.some((message) =>
      Array.isArray(message?.content) &&
      message.content.some((block) => block?.type === 'tool_result'),
    );
    if (hasToolResult) {
      json(res, 200, anthropicMessage([
        { type: 'text', text: 'WORK_E2E_OK' },
      ]));
      return;
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      json(res, 200, anthropicMessage([
        {
          type: 'tool_use',
          id: 'toolu_trylo_e2e_readme',
          name: 'read_file',
          input: { path: 'README.md', maxChars: 1000 },
        },
      ], 'tool_use'));
      return;
    }

    const transcript = JSON.stringify(messages);
    if (!transcript.includes('Create an execution plan.')) {
      const marker = transcript.includes('FOLLOWUP_E2E_OK')
        ? 'FOLLOWUP_E2E_OK'
        : 'WORK_E2E_OK';
      json(res, 200, anthropicMessage([
        { type: 'text', text: marker },
      ]));
      return;
    }

    json(res, 200, anthropicMessage([
      {
        type: 'text',
        text: JSON.stringify({
          description: 'Read-only Work E2E',
          steps: [{ id: '1', description: 'Read README.md and report WORK_E2E_OK' }],
        }),
      },
    ]));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TRYLO_E2E_LLM_READY http://127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
