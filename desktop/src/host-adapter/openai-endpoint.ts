const INVALID_API_HOST = 'API host 必须是有效的 http(s) 地址。';

/** Desktop stores an API base; the new CLI consumes a complete request URL. */
export function openAiRequestEndpoint(apiHost: string): string {
  let url: URL;
  try {
    url = new URL(apiHost);
  } catch {
    throw new Error(INVALID_API_HOST);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(INVALID_API_HOST);
  }
  const base = url.pathname.replace(/\/+$/, '');
  if (!base.endsWith('/chat/completions') && !base.endsWith('/responses')) {
    url.pathname = `${base || '/v1'}/chat/completions`;
  }
  return url.toString();
}
