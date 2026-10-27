export function createApi(scope) {
  let csrf = '';
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`/api/${scope}${path}`, { ...options, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
    } catch (cause) {
      throw Object.assign(new Error(cause.name === 'TimeoutError' ? '请求超时，请检查网络连接。' : '无法连接服务器，请检查网络连接。', { cause }), { uncertain: Boolean(options.method && options.method !== 'GET') });
    }
    let result;
    try { result = await response.json(); }
    catch { throw Object.assign(new Error(`服务器响应异常 (${response.status})，请稍后重试。`), { status: response.ok ? 502 : response.status, uncertain: response.ok && Boolean(options.method && options.method !== 'GET') }); }
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : `请求失败 (${response.status})`), { status: response.status });
    return result;
  }
  return { request, async session() { const value = await request('/session'); csrf = value.csrf; return value; }, clear() { csrf = ''; } };
}
