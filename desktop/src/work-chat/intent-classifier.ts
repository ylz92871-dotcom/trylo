// Trylo Desktop — Work intent classifier.
//
// 2026-08-30: decides at SEND time whether a Work message is a task
// (route to the cowork daemon's task pipeline) or a chat (route to the
// Code runtime). The old `looksLikeTaskIntent` keyword regex over- and
// under-matches ("帮我看看这个bug" → task, "把教案转成PDF" → chat),
// which is exactly why Work felt unable to tell the two apart.
//
// Strategy: probe the LLM ONLY when the message carries task *signals*
// (verb stems, deliverable words, length). A plain "你好" / question
// skips the probe and stays chat. The probe asks the model to output a
// single token (`task` / `chat`); on any failure it falls back to the
// deterministic keyword rule so a send can never block on the probe.

import type { TryloSettings } from '../settings/settings-store';

export type WorkIntent = 'task' | 'chat';

/** One-shot probe result. */
export interface IntentProbe {
  readonly intent: WorkIntent;
  /** Which path produced the verdict: the LLM probe, the keyword
   *  fallback, or a skipped probe (no task signals). */
  readonly source: 'llm' | 'fallback' | 'skip';
  /** Short evidence string for diagnostics (the keyword hit or the
   *  model's reason). Never shown to the end user. */
  readonly reason: string;
}

/** Minimal set of verb stems that strongly signal "execute something".
 *  Deliberately does NOT include /帮我|给我|为我/ — those constantly
 *  appear in plain questions ("给我讲讲这个文件") and were the single
 *  biggest source of task false-positives. */
const TASK_SIGNAL_PATTERNS: readonly RegExp[] = [
  // deliverable verbs (zh)
  /整理|生成|制作|创建|撰写|编写|重写|改写|导出|导入|转换|转成|批量|排版|校对|翻译|压缩|合并|拆分|统计|汇总|分析|归纳|提取|筛选|排序|读取|下载|爬取|抓取/,
  // deliverable nouns (zh)
  /报告|表格|教案|PPT|幻灯片|Excel|Word|PDF|文案|文章|文档|清单|数据|文件|清单|课件|纪要|周报|月报/,
  // strong english verbs
  /\b(create|generate|make|build|prepare|write|summarize|rewrite|convert|export|analyze|organise|organize|compile|extract|download|translat|format)\b/i,
];

/** True when the message carries enough task signals to justify an LLM
 *  probe. A plain greeting / short question returns false and stays chat
 *  with zero probe cost. */
export function shouldProbeIntent(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.length > 1200) return false;
  return TASK_SIGNAL_PATTERNS.some((re) => re.test(t));
}

/** Deterministic keyword verdict. Used as the probe fallback and as the
 *  "clear enough, no LLM needed" shortcut at the two poles. */
export function keywordIntent(text: string): WorkIntent {
  // Strong negative first: an explicit pure-question wrapper is chat even
  // when it happens to mention a deliverable noun.
  if (/^(请(问|告诉我)|什么是|为什么|怎么[样办]|能否|可以.*吗|帮我看看|给我讲讲)/.test(text.trim())) {
    return 'chat';
  }
  return TASK_SIGNAL_PATTERNS.some((re) => re.test(text)) ? 'task' : 'chat';
}

/** Resolve the provider HTTP endpoint + auth for a one-shot probe.
 *  Mirrors the shape the Trylo runner builds for the CLI env, but here
 *  we call the REST endpoint directly (no child process). */
function providerTarget(settings: TryloSettings): {
  url: string;
  headers: Record<string, string>;
  model: string;
  body: (user: string) => Record<string, unknown>;
} {
  const format = settings.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const host = settings.apiHost.trim();
  const base = host || (format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  const model = settings.apiModel.trim() || 'claude-3-5-haiku-latest';

  if (format === 'anthropic') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (settings.apiKeyPrefix.trim()) headers['authorization'] = `Bearer ${settings.apiKeyPrefix.trim()}${settings.apiKey}`;
    return {
      url: `${base.replace(/\/$/, '')}/v1/messages`,
      headers,
      model,
      body: (user) => ({ model, max_tokens: 8, system: systemPromptFor(), messages: [{ role: 'user', content: user }] }),
    };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `${settings.apiKeyPrefix.trim() || 'Bearer'} ${settings.apiKey}`,
  };
  if (settings.apiKeyHeader.trim()) headers['x-api-key'] = settings.apiKey;
  return {
    url: `${base.replace(/\/$/, '')}/chat/completions`,
    headers,
    model,
    body: (user) => ({ model, max_tokens: 8, messages: [{ role: 'system', content: systemPromptFor() }, { role: 'user', content: user }] }),
  };
}

function systemPromptFor(): string {
  return (
    'You classify a single user message for a productivity assistant. ' +
    'Reply with exactly one word: "task" if the user is asking you to DO a piece of work ' +
    '(create/modify/convert/summarize/produce a deliverable, run a multi-step job). ' +
    'Reply "chat" if the user is just asking a question, explaining something, greening, ' +
    'or requesting an opinion. No other words, no punctuation.'
  );
}

function buildProbeUserMessage(text: string): string {
  return `Classify: "${text}"\nAnswer exactly "task" or "chat".`;
}

/** One-shot LLM probe. Returns the verdict, or null on any failure so the
 *  caller can fall back to `keywordIntent`. Never throws. */
async function llmProbe(
  text: string,
  settings: TryloSettings,
  timeoutMs: number,
): Promise<WorkIntent | null> {
  if (!settings.apiKey.trim()) return null;
  const target = providerTarget(settings);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(target.body(buildProbeUserMessage(text))),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const token = extractToken(data);
    if (!token) return null;
    const lowered = token.toLowerCase();
    if (lowered.includes('task')) return 'task';
    if (lowered.includes('chat')) return 'chat';
    return null;
  } catch {
    return null;
  }
}

/** Pull the first text token out of either provider response shape. */
function extractToken(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  // OpenAI: choices[0].message.content
  const choices = d.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const msg = first.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === 'string') return content;
  }
  // Anthropic: content[0].text
  const contentArr = d.content;
  if (Array.isArray(contentArr) && contentArr.length > 0) {
    const first = contentArr[0] as Record<string, unknown>;
    if (typeof first.text === 'string') return first.text;
  }
  // Fallback: first string anywhere in a shallow scan.
  for (const v of Object.values(d)) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/** Public entry: classify a Work message, probing the LLM only when task
 *  signals are present. Always returns a usable verdict.
 *
 * - No task signals        → `{ intent:'chat', source:'skip' }`
 * - Signals + probe ok     → `{ intent:<llm>, source:'llm' }`
 * - Signals + probe failed → `{ intent:<keyword>, source:'fallback' }`
 */
export async function classifyWorkIntent(
  text: string,
  settings: TryloSettings,
  timeoutMs = 4000,
): Promise<IntentProbe> {
  if (!shouldProbeIntent(text)) {
    return { intent: keywordIntent(text), source: 'skip', reason: 'no task signals' };
  }
  const llm = await llmProbe(text, settings, timeoutMs);
  if (llm !== null) {
    return { intent: llm, source: 'llm', reason: 'llm probe' };
  }
  const kw = keywordIntent(text);
  return { intent: kw, source: 'fallback', reason: `keyword fallback: ${kw}` };
}
