import { describe, expect, it } from 'vitest';
import { completeJson, createLearningLlm } from './llm';

describe('Learning LLM fail-closed', () => {
  it('returns null without an API key', async () => {
    const llm = createLearningLlm({ apiKey: '' });
    expect(await llm.complete('evidence', 'trace')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const llm = createLearningLlm(
      { apiKey: 'sk-test', apiFormat: 'anthropic' },
      async () => { throw new Error('network'); },
    );
    expect(await completeJson(llm, 'evidence', '{}')).toBeNull();
  });

  it('returns null on non-OK HTTP', async () => {
    const llm = createLearningLlm(
      { apiKey: 'sk-test', apiFormat: 'openai', apiHost: 'https://example.invalid' },
      async () => new Response('nope', { status: 500 }),
    );
    expect(await llm.complete('policy', 'um')).toBeNull();
  });
});
