// Trylo Desktop Services — pet chat LLM client.
//
// Extracted from the legacy extension's requestOpenAI / requestAnthropic
// (extension.js ~17071 / ~17164) per migration spec §6.4 and rewritten as
// ESM over ./llm-http.mjs. Stream semantics (text deltas + reasoning
// deltas + usage callbacks), request body shapes (thinking configs), and
// the 'No assistant text found in model response.' contract are preserved.
// All configuration arrives injected per request from the Desktop settings
// — nothing is read from disk or env here.

import {
  buildHeaders,
  isAbortError,
  postJson,
  postSseJson,
  resolveAnthropicEndpoint,
  resolveOpenAIEndpoint,
  toErrorMessage,
} from './llm-http.mjs';

export { isAbortError, toErrorMessage };

// ── thinking configs (legacy-verbatim) ───────────────────────────────

function normalizeThinkingBudget(value) {
  const budget = Math.max(0, Number(value) || 0);
  return Number.isFinite(budget) ? Math.floor(budget) : 0;
}

function applyThinkingConfigToOpenAIRequestBody(body, config) {
  const budget = normalizeThinkingBudget(config && config.thinkingBudget);
  if (!budget) return;

  const endpoint = String((config && config.endpoint) || '').toLowerCase();
  const providerId = String((config && config.providerId) || '').toLowerCase();
  const useThinkingObject = providerId === 'siliconflow' || endpoint.includes('siliconflow');

  if (useThinkingObject) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };
    return;
  }

  body.enable_thinking = true;
  body.thinking_budget = budget;
}

function buildAnthropicThinkingConfig(thinkingBudget) {
  const budget = normalizeThinkingBudget(thinkingBudget);
  if (!budget) return null;
  return {
    type: 'enabled',
    budget_tokens: budget,
  };
}

// ── response extraction (legacy-verbatim) ────────────────────────────

function collectReasoningTextFragments(node, options = {}, seen = new WeakSet()) {
  if (node == null) return [];
  if (typeof node === 'string') {
    return options.allowPlainText ? [node] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((item) => collectReasoningTextFragments(item, options, seen));
  }
  if (typeof node !== 'object') return [];
  if (seen.has(node)) return [];
  seen.add(node);

  const out = [];
  const type = String(node.type || '').trim().toLowerCase();
  const isReasoningNode =
    type === 'reasoning_content' ||
    type === 'reasoning' ||
    type === 'thinking' ||
    Boolean(node.reasoning_content) ||
    Boolean(node.reasoning) ||
    Boolean(node.thinking);
  if (isReasoningNode) {
    for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) out.push(value);
      else if (Array.isArray(value)) out.push(...collectReasoningTextFragments(value, options, seen));
    }
  }
  if (Array.isArray(node.content)) {
    out.push(...collectReasoningTextFragments(node.content, options, seen));
  }
  return out;
}

function extractOpenAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function extractOpenAIReasoningContent(data) {
  const message = data?.choices?.[0]?.message;
  const fragments = collectReasoningTextFragments(message);
  return (fragments.length ? fragments : collectReasoningTextFragments(data))
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

function extractAnthropicReasoningContent(data) {
  return collectReasoningTextFragments(data)
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** The legacy path normalized usage for token accounting UIs; the pet chat
 *  only mirrors it to an optional callback, so a shallow pass-through with
 *  attribution is sufficient (modernization, protocol-neutral). */
function normalizeUsage(usage, model, source) {
  if (!usage || typeof usage !== 'object') return null;
  return { ...usage, model: String(model || ''), source };
}

// ── requestOpenAI (legacy structure, ESM rewrite) ────────────────────

export async function requestOpenAI(config, prompt, signal, options = {}) {
  const endpoint = resolveOpenAIEndpoint(config.endpoint);
  const headers = buildHeaders(config);
  const messages = [];
  if (config.systemPrompt.trim()) {
    messages.push({ role: 'system', content: config.systemPrompt });
  }
  const providedMessages = Array.isArray(options.messages)
    ? options.messages
        .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
        .map((message) => ({ role: message.role, content: String(message.content || '') }))
    : [];
  messages.push(...(providedMessages.length ? providedMessages : [{ role: 'user', content: prompt }]));
  const body = { model: config.model, messages };
  applyThinkingConfigToOpenAIRequestBody(body, config);
  if (Number.isFinite(options.maxTokens)) body.max_tokens = options.maxTokens;
  if (typeof options.temperature === 'number') body.temperature = options.temperature;

  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
    let out = '';
    let reasoning = '';
    let finalUsage = null;
    const streamResult = await postSseJson(endpoint, headers, body, signal, (payload) => {
      if (payload && payload.error) {
        throw new Error(payload.error.message || payload.error.type || 'OpenAI stream failed.');
      }
      const delta = payload && payload.choices && payload.choices[0] ? payload.choices[0].delta || {} : {};
      const textDelta =
        typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('')
            : '';
      const reasoningDelta =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        if (typeof options.onThinkingDelta === 'function') options.onThinkingDelta(reasoningDelta);
      }
      if (textDelta) {
        out += textDelta;
        if (typeof options.onTextDelta === 'function') options.onTextDelta(textDelta);
      }
      if (payload && payload.usage) {
        finalUsage = normalizeUsage(payload.usage, config.model, 'chat-openai');
        if (finalUsage && typeof options.onUsage === 'function') options.onUsage(finalUsage);
      }
    }, options.timeoutMs);
    if (!streamResult.streamed && streamResult.data) {
      out = extractOpenAIText(streamResult.data);
      reasoning = extractOpenAIReasoningContent(streamResult.data);
      if (reasoning && typeof options.onThinkingDelta === 'function') options.onThinkingDelta(reasoning);
      if (out && typeof options.onTextDelta === 'function') options.onTextDelta(out);
      finalUsage = normalizeUsage(streamResult.data.usage, config.model, 'chat-openai');
      if (finalUsage && typeof options.onUsage === 'function') options.onUsage(finalUsage);
    }
    if (!out && !reasoning) throw new Error('No assistant text found in model response.');
    return { text: out, reasoning_content: reasoning, usage: finalUsage };
  }

  const data = await postJson(endpoint, headers, body, signal, options.timeoutMs);
  const out = extractOpenAIText(data);
  const reasoning = extractOpenAIReasoningContent(data);
  if (!out && !reasoning) throw new Error('No assistant text found in model response.');
  return {
    text: out,
    reasoning_content: reasoning,
    usage: normalizeUsage(data.usage, config.model, 'chat-openai'),
  };
}

// ── requestAnthropic (legacy structure, ESM rewrite) ─────────────────

export async function requestAnthropic(config, prompt, signal, options = {}) {
  const endpoint = resolveAnthropicEndpoint(config.endpoint);
  const headers = buildHeaders(config);
  const body = {
    model: config.model,
    max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 2048,
    messages:
      Array.isArray(options.messages) && options.messages.length
        ? options.messages
            .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
            .map((message) => ({ role: message.role, content: String(message.content || '') }))
        : [{ role: 'user', content: prompt }],
  };
  const thinking = buildAnthropicThinkingConfig(config.thinkingBudget || 0);
  if (thinking) body.thinking = thinking;
  if (config.systemPrompt.trim()) body.system = config.systemPrompt;
  if (typeof options.temperature === 'number') body.temperature = options.temperature;

  if (options.stream) {
    body.stream = true;
    let out = '';
    let reasoning = '';
    let latestUsage = null;
    let accumulatedUsage = {};
    const streamResult = await postSseJson(endpoint, headers, body, signal, (payload) => {
      if (payload && payload.type === 'error') {
        const streamError = payload.error || {};
        throw new Error(streamError.message || streamError.type || 'Anthropic stream failed.');
      }
      if (payload && payload.type === 'message_start' && payload.message && payload.message.usage) {
        accumulatedUsage = { ...accumulatedUsage, ...payload.message.usage };
      }
      if (payload && payload.type === 'message_delta' && payload.usage) {
        accumulatedUsage = { ...accumulatedUsage, ...payload.usage };
      }
      const delta = payload && payload.type === 'content_block_delta' ? payload.delta || {} : {};
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        reasoning += delta.thinking;
        if (typeof options.onThinkingDelta === 'function') options.onThinkingDelta(delta.thinking);
      }
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        out += delta.text;
        if (typeof options.onTextDelta === 'function') options.onTextDelta(delta.text);
      }
      if (payload && (payload.type === 'message_start' || payload.type === 'message_delta')) {
        latestUsage = normalizeUsage(
          accumulatedUsage,
          (payload.message && payload.message.model) || config.model,
          'chat-anthropic',
        );
        if (latestUsage && typeof options.onUsage === 'function') options.onUsage(latestUsage);
      }
    }, options.timeoutMs);
    if (!streamResult.streamed && streamResult.data) {
      out = extractAnthropicText(streamResult.data);
      reasoning = extractAnthropicReasoningContent(streamResult.data);
      if (reasoning && typeof options.onThinkingDelta === 'function') options.onThinkingDelta(reasoning);
      if (out && typeof options.onTextDelta === 'function') options.onTextDelta(out);
      latestUsage = normalizeUsage(streamResult.data.usage, streamResult.data.model || config.model, 'chat-anthropic');
      if (latestUsage && typeof options.onUsage === 'function') options.onUsage(latestUsage);
    }
    if (!out && !reasoning) throw new Error('No assistant text found in model response.');
    return { text: out, reasoning_content: reasoning, usage: latestUsage };
  }

  const data = await postJson(endpoint, headers, body, signal, options.timeoutMs);
  const out = extractAnthropicText(data);
  const reasoning = extractAnthropicReasoningContent(data);
  if (!out && !reasoning) throw new Error('No assistant text found in model response.');
  return {
    text: out,
    reasoning_content: reasoning,
    usage: normalizeUsage(data.usage, data.model || config.model, 'chat-anthropic'),
  };
}
