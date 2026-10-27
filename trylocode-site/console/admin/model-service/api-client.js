// Reuse the existing administrator session, CSRF protection and error handling.
// No provider keys or separate model-service login are held by this client.
export function createModelAdminClient(api) {
  const mutate = async (route, body, method = 'POST') => {
    await api.session();
    return api.request(`/model-service${route}`, { method, body });
  };
  return {
    load: () => api.request('/model-service'),
    saveUpstream: value => mutate('/upstreams', value),
    saveGrant: value => mutate('/grants', value),
    setUpstreamEnabled: (id, enabled) => mutate(`/upstreams/${encodeURIComponent(id)}/enabled`, { enabled }),
    saveCredential: (id, apiKey, slot = 'primary') => mutate(`/upstreams/${encodeURIComponent(id)}/credential`, { apiKey, slot }),
    syncCatalog: id => mutate(`/upstreams/${encodeURIComponent(id)}/catalog`, {}),
    revokeGrant: id => mutate(`/grants/${encodeURIComponent(id)}`, {}, 'DELETE'),
  };
}
