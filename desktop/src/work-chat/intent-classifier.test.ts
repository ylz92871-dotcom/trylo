import { describe, it, expect } from 'vitest';
import {
  classifyWorkIntent,
  shouldProbeIntent,
  keywordIntent,
} from './intent-classifier';
import type { TryloSettings } from '../settings/settings-store';

const SETTINGS = {
  apiKey: '',
  apiHost: '',
  apiModel: '',
  apiFormat: 'anthropic',
  apiKeyHeader: '',
  apiKeyPrefix: '',
  extraHeadersText: '{}',
  providerId: '',
  systemPrompt: '',
} as TryloSettings;

describe('intent-classifier: keyword fallback', () => {
  it('plain greetings/questions stay chat and skip the probe', () => {
    for (const text of ['你好', '在吗', '谢谢', '这个功能怎么用']) {
      expect(shouldProbeIntent(text)).toBe(false);
      expect(keywordIntent(text)).toBe('chat');
    }
  });

  it('"帮我看看bug" is chat, not a task (old regex wrongly matched /帮我/)', () => {
    expect(keywordIntent('帮我看看这个bug是怎么回事')).toBe('chat');
  });

  it('"把教案转成PDF" is a task (old regex wrongly missed /转成/)', () => {
    expect(keywordIntent('把教案转成PDF')).toBe('task');
    expect(keywordIntent('帮我重新排版这份PPT')).toBe('task');
    expect(keywordIntent('生成一份周报')).toBe('task');
  });

  it('ambiguous message still probes but keyword fallback is chat', () => {
    expect(shouldProbeIntent('给我讲讲这个文件里的内容')).toBe(true);
    expect(keywordIntent('给我讲讲这个文件里的内容')).toBe('chat');
  });
});

describe('intent-classifier: classifyWorkIntent', () => {
  it('no task signals -> skip source, zero LLM cost', async () => {
    const p = await classifyWorkIntent('你好', SETTINGS);
    expect(p.intent).toBe('chat');
    expect(p.source).toBe('skip');
  });

  it('no api key -> keyword fallback for a task-signal message', async () => {
    const p = await classifyWorkIntent('把教案转成PDF', SETTINGS);
    expect(p.intent).toBe('task');
    expect(p.source).toBe('fallback');
  });

  it('task-signal message without api key still resolves to a usable verdict', async () => {
    const p = await classifyWorkIntent('分析一下这组销售数据', SETTINGS);
    expect(['task', 'chat']).toContain(p.intent);
    expect(p.source).toBe('fallback');
  });
});
