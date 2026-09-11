// Trylo Desktop Services — pet chat command handler.
//
// Port of the legacy handleDesktopChatCommand (extension.js ~7101-7211)
// per migration spec §6.4. What is intentionally NOT ported: the whole
// Fun/猫箱 branch (handleDesktopFunCommand) — the entry rejects every
// non-chat mode with an explicit chat_error so the pet can never fall
// back into silent nothing (spec: fun 请求显式返回不支持).
//
// Protocol surface preserved from the legacy implementation:
//   messages  chat_started / chat_delta(sequence) / chat_complete /
//             chat_error / chat_history / chat_cleared
//   limits    DESKTOP_CHAT_LIMITS (80 messages / 36 context / 16000 chars)
//   copy      'Message is empty.' / 'Trylo is already replying in the
//             desktop chat.' / '已停止本次回复。' / 'The model returned an
//             empty response.'
// Chat is conversation-only by construction: no tools, no permissions, no
// filesystem access beyond the chat history file.

import crypto from 'node:crypto';

import {
  DESKTOP_CHAT_LIMITS,
  desktopChatSystemPrompt,
  sanitizeDesktopChatMessages,
  shortText,
} from './chat-limits.mjs';
import { isAbortError, requestAnthropic, requestOpenAI, toErrorMessage } from './llm-client.mjs';

function timeoutMinutesToMs(minutes) {
  const numeric = Number(minutes);
  const safe = Number.isFinite(numeric) && numeric >= 0 ? Math.min(24 * 60, Math.round(numeric)) : 0;
  if (!safe) return 0;
  return safe * 60 * 1000;
}

/**
 * @param {object} deps
 * @param {{read: () => Promise<any[]>, write: (messages: any[]) => Promise<boolean>}} deps.store
 *        Chat history store (see ./chat-store.mjs).
 */
export function createDesktopChatCommand({ store }) {
  // Single-flight state, mirroring the legacy module globals
  // desktopChatController / desktopChatRequestId.
  let controller = null;
  let currentRequestId = '';

  return async function handleDesktopChatCommand(message, emit, chatConfig) {
    const type = String((message && message.type) || '');
    const requestId = String((message && message.requestId) || '');
    const mode = String((message && message.mode) || 'chat').toLowerCase();
    const respond = (payload) => {
      if (typeof emit === 'function') emit({ ...payload, mode, at: Date.now() });
    };

    // Fun (猫箱) is not migrated (user decision, spec §12-2): reject every
    // non-chat mode up front. The pet channel already gates, this is the
    // fail-closed second layer.
    if (mode !== 'chat') {
      respond({ type: 'chat_error', requestId, error: '本版本不支持猫箱(Fun)模式。' });
      return;
    }

    if (type === 'chat_history_request') {
      respond({ type: 'chat_history', messages: await store.read() });
      return;
    }

    if (type === 'chat_cancel') {
      if (controller && (!requestId || requestId === currentRequestId)) {
        controller.abort();
      }
      return;
    }

    if (type === 'chat_clear') {
      if (controller && !controller.signal.aborted) controller.abort();
      controller = null;
      currentRequestId = '';
      await store.write([]);
      respond({ type: 'chat_cleared' });
      return;
    }

    if (type !== 'chat_send') return;
    const prompt = shortText(String((message && message.text) || '').trim(), DESKTOP_CHAT_LIMITS.maxMessageChars);
    if (!prompt) {
      respond({ type: 'chat_error', requestId, error: 'Message is empty.' });
      return;
    }
    if (controller && !controller.signal.aborted) {
      respond({ type: 'chat_error', requestId, error: 'Trylo is already replying in the desktop chat.' });
      return;
    }

    const abort = new AbortController();
    controller = abort;
    currentRequestId = requestId || crypto.randomUUID();
    const effectiveRequestId = currentRequestId;
    let messages = await store.read();
    messages = sanitizeDesktopChatMessages(messages.concat({ role: 'user', text: prompt, at: Date.now() }));
    await store.write(messages);
    respond({ type: 'chat_started', requestId: effectiveRequestId });

    try {
      const config = chatConfig || {};
      if (!config.endpoint) throw new Error('API endpoint is missing. Configure it in the Trylo desktop settings.');
      if (!config.apiKey && config.apiKeyHeader) {
        throw new Error('API key is missing. Configure it in the Trylo desktop settings.');
      }
      const resolvedConfig = {
        ...config,
        model: String(config.model || '').trim(),
        systemPrompt: desktopChatSystemPrompt(config),
      };
      const modelMessages = messages
        .slice(-DESKTOP_CHAT_LIMITS.maxContextMessages)
        .map((item) => ({ role: item.role, content: item.text }));
      let sequence = 0;
      const options = {
        stream: true,
        messages: modelMessages,
        timeoutMs: timeoutMinutesToMs(config.taskTimeoutMinutes) || 5 * 60 * 1000,
        onTextDelta: (delta) => {
          if (!delta || abort.signal.aborted) return;
          respond({
            type: 'chat_delta',
            requestId: effectiveRequestId,
            sequence: ++sequence,
            delta: String(delta),
          });
        },
      };
      const result =
        config.apiFormat === 'anthropic'
          ? await requestAnthropic(resolvedConfig, prompt, abort.signal, options)
          : await requestOpenAI(resolvedConfig, prompt, abort.signal, options);
      const answer = String((result && (result.text || result.reasoning_content)) || '').trim();
      if (!answer) throw new Error('The model returned an empty response.');
      messages = sanitizeDesktopChatMessages(
        messages.concat({
          role: 'assistant',
          text: answer,
          at: Date.now(),
        }),
      );
      await store.write(messages);
      respond({ type: 'chat_complete', requestId: effectiveRequestId, text: answer });
    } catch (err) {
      respond({
        type: 'chat_error',
        requestId: effectiveRequestId,
        error: isAbortError(err) ? '已停止本次回复。' : toErrorMessage(err),
      });
    } finally {
      if (controller === abort) controller = null;
      if (currentRequestId === effectiveRequestId) currentRequestId = '';
    }
  };
}
