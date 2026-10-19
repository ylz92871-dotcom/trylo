/** Translate Desktop connection fields to the legacy SDK's real header input. */
export function legacyConnectionEnv(input: {
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const headers = new Map<string, { name: string; value: string }>();
  const setHeader = (name: string, value: string): void => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('连接配置包含无效的请求头，请检查模型设置。');
    }
    headers.set(name.toLowerCase(), { name, value });
  };
  const rawHeaders = input.extraHeadersText?.trim();
  if (rawHeaders && rawHeaders !== '{}') {
    if (rawHeaders.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(rawHeaders); } catch { throw new Error('扩展请求头必须是有效的 JSON 对象。'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('扩展请求头必须是 JSON 对象。');
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') throw new Error('扩展请求头的值必须是字符串。');
        setHeader(name.trim(), value);
      }
    } else {
      for (const line of rawHeaders.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const colon = line.indexOf(':');
        if (colon < 1) throw new Error('扩展请求头格式无效，请使用 JSON 对象或每行 name: value。');
        setHeader(line.slice(0, colon).trim(), line.slice(colon+1).trim());
      }
    }
  }
  if (input.apiKey) {
    env.ANTHROPIC_API_KEY = input.apiKey;
    // An explicit Desktop connection must not inherit a different bearer token.
    env.ANTHROPIC_AUTH_TOKEN = '';
    const header = input.apiKeyHeader?.trim() || (input.apiFormat === 'openai' ? 'Authorization' : '');
    if (header) {
      const prefix = input.apiKeyHeader?.trim() ? input.apiKeyPrefix ?? '' : 'Bearer ';
      setHeader(header, `${prefix}${input.apiKey}`);
    }
  }
  if (input.apiHost) env.ANTHROPIC_BASE_URL = input.apiHost;
  if (input.apiModel) env.ANTHROPIC_MODEL = input.apiModel;
  if (headers.size) env.ANTHROPIC_CUSTOM_HEADERS = [...headers.values()].map(({ name, value }) => `${name}: ${value}`).join('\n');
  return env;
}
