import {
  CONCLUSION_SKILL_PROMPT,
  COGNITION_INTERVIEWER_PROMPT,
  EVIDENCE_EXTRACTOR_PROMPT,
  POLICY_COMPILER_PROMPT,
  USER_MODEL_SKILL_PROMPT,
} from './prompts';
import type { LearningSkillName } from './types';

export interface LearningLlmConfig {
  readonly apiKey: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
}

export type { LearningSkillName } from './types';

export interface LearningLlm {
  readonly metadata?: { readonly provider: string; readonly model: string };
  complete(skill: LearningSkillName, user: string): Promise<string | null>;
}

const SKILL_PROMPTS: Record<LearningSkillName, string> = {
  evidence: EVIDENCE_EXTRACTOR_PROMPT,
  conclusion: CONCLUSION_SKILL_PROMPT,
  user_model: USER_MODEL_SKILL_PROMPT,
  policy: POLICY_COMPILER_PROMPT,
  cognition: COGNITION_INTERVIEWER_PROMPT,
};

function parseJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function createLearningLlm(config: LearningLlmConfig, fetchImpl: typeof fetch = fetch): LearningLlm {
  const format = config.apiFormat === 'openai' ? 'openai' : 'anthropic';
  const model = config.apiModel?.trim() || 'claude-3-5-haiku-latest';
  return {
    metadata: { provider: format, model },
    async complete(skill, user) {
      if (!config.apiKey.trim()) return null;
      const host = (config.apiHost ?? '').trim();
      const base = host || (format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
      const system = SKILL_PROMPTS[skill];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        if (format === 'anthropic') {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          };
          if (config.apiKeyPrefix?.trim()) {
            headers.authorization = `Bearer ${config.apiKeyPrefix.trim()}${config.apiKey}`;
          }
          const res = await fetchImpl(`${base.replace(/\/$/, '')}/v1/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              max_tokens: 800,
              system,
              messages: [{ role: 'user', content: user }],
            }),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const body = await res.json() as { content?: Array<{ text?: string }> };
          return body.content?.[0]?.text ?? null;
        }
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          authorization: `${config.apiKeyPrefix?.trim() || 'Bearer'} ${config.apiKey}`,
        };
        if (config.apiKeyHeader?.trim()) headers['x-api-key'] = config.apiKey;
        const res = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: 800,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        return body.choices?.[0]?.message?.content ?? null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function completeJson(
  llm: LearningLlm | null | undefined,
  skill: LearningSkillName,
  user: string,
): Promise<unknown | null> {
  if (!llm) return null;
  try {
    const text = await llm.complete(skill, user);
    if (!text) return null;
    return parseJsonObject(text);
  } catch {
    return null;
  }
}
