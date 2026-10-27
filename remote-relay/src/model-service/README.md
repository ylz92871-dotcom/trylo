# Model quota service

`quota.mjs` owns allocation, admission and accounting in the existing
`accounts.sqlite`. `service.mjs` binds those operations to existing administrator,
web-account and native-account authentication. No new user or login store exists.
The administrator view is `trylocode-site/console/admin/model-service`; account
quota and usage views reuse `console/user/app.js`.

## Current capability

- Per-upstream shared pool and per-account grants, measured separately in tokens
  or requests. New users receive no grants. Sources start paused.
- Day, Monday-start week and calendar month use Asia/Shanghai. Five-hour windows
  are fixed windows anchored to source creation, not a provider's rolling quota.
- SQLite `BEGIN IMMEDIATE` atomically checks allowance, holds quota and enforces
  concurrent limits: global 4, per account 2, and configured source limit.
- User-selected request keys are unique per account; duplicate calls are rejected,
  never silently replayed. The ledger stores a hash, not prompt content.
- Unsent cancellation releases a hold. Dispatched requests with unknown usage
  retain their worst-case charge. Trusted late usage or an administrator's
  evidence-based reconciliation settles it once. Over-ceiling usage is recorded
  in full and pauses the source; a provider's actual charges are not concealed.
- Configuration changes and reconciliation enter the existing administrator audit.
  Account/upstream identities and historical units/periods cannot be relabeled.
- Account cookies/CSRF and native bearer authorization remain authoritative.
  Phone pairing credentials cannot call the native model routes. Clients cannot
  supply another user's ID, usage values, public settlement or an arbitrary URL.

## Provider boundary

`TRYLO_ENABLE_AMD_POOL=1` enables the AMD adapter and AES-256-GCM credential vault.
The master key lives in the private data directory (0600); database ciphertext
is authenticated against source ID, exact API endpoint and protocol. Changing
the endpoint makes the old credential unusable. Existing administrator sessions
and CSRF protect credential rotation and catalog refresh; snapshots expose status
only. No master key, API key or prompt is placed in public assets or audit records.

The same source can hold primary and secondary encrypted account slots; it still
has one grant and ledger. Requests rotate by active load and last selection;
rejected/rate-limited accounts cool down without replaying a dispatched operation.
Catalog refresh intersects the member catalogs. Adding a key does not double the
1000/day user quota. The admin credential form selects the account being replaced.

The adapter pins all outbound requests to
`https://developer.amd.com.cn/radeon/api/v1`, refuses redirects and supports only
the free/request-count/Chat configuration. The AMD catalog is imported in full,
with output/vision/tool/streaming capabilities. Text models support bounded unary
and SSE Chat requests; audio, OCR and decision models stay visible in the catalog
but their dedicated invocation routes are not implemented. Upstream `free` or cost
metadata is not treated as a verified billing promise; this is the Trylo owner-funded
free pool. Daily per-account allocation is 1000 requests; the bootstrap shared cap
is 100000/day, source concurrency 2, per-account concurrency 1. These are Trylo
limits, not a statement of AMD's official allowance. Other users still need grants.

Requests can name a granted `upstreamId` or `{pool:'free',model,...}`. Free routing
considers enabled, credential-ready, granted sources with remaining allowance;
it never falls back to paid plans or replays a dispatched call. Replays are rejected
by the existing ledger. SSE ends with `[DONE]` only after upstream completion and
quota settlement. Truncated/failed/unknown dispatched calls retain one request as
uncertain. Explicit HTTP/SSE rejection ends an attempted request with one debit,
releasing its concurrency slot. Multiple CLI system/developer messages are merged
in order into one leading AMD system message. Invalid messages, unready sources and specialist-chat misuse fail before
reservation. There is no universal token quote, so AMD Token-based pools are refused.

Without the explicit flag, no vault/master-key files are created and model calls
remain disabled. Desktop custom APIs still bypass this service. The native account
model/quotas/usage/request endpoints exist, but the Desktop provider selector and
its streaming path are not integrated in the published Desktop 1.0.6 installer.
Current Desktop source and staged Service Host resources do integrate them:
authorized text-only discovery, model-scoped ephemeral loopback credentials,
streaming and tool continuation passed with the actual staged CLI and AMD. The
native account bearer remains in the Service Host. See the dual-account Desktop
release record in `docs/release/` for evidence and the native UI/installer boundary.

Additional Token-based adapters must implement `quote({source,model,payload})`
with a verified upper bound and `run({source,model,payload,signal,onChunk})`
returning `{value,units}` after trustworthy completion. Missing usage retains the
quote, including reasoning/cache accounting; no characters-to-tokens estimate is
assumed. The current AMD adapter meters one request for unary or completed SSE.
Adding Token-based streaming needs a provider-specific trustworthy meter. No
automatic fallback to a different paid source is performed.

This is a **single active service process per database**. Startup recovery treats
old dispatched operations as uncertain; do not run multiple independent workers
against one database. The two-connection test proves atomic reservations, not
multiworker ownership/recovery. The ledger fails closed at 100,000 requests;
archival needs an explicit retention/checkpoint design before larger rollout.

## APIs

Admin: `/api/admin/model-service`, `/upstreams`, `/grants`,
`/upstreams/:id/enabled`, `/grants/:id`, `/requests`,
`/requests/:id/reconcile` (relative to the first path).
Account: GET `/api/account/model-quotas` and `/model-usage`, POST `/model-requests`.
Native equivalents: `/relay/model-quotas`, `/relay/model-usage`,
`/relay/model-requests`. All require the corresponding existing session.

Admin credential rotation: POST `/api/admin/model-service/upstreams/:id/credential`
with `{apiKey}`. Catalog refresh: POST `.../upstreams/:id/catalog`. Model discovery:
GET `/api/account/models` or `/relay/models`. No unscoped public API keys are issued.
The offline `model-admin.cjs import-amd` maintenance entrypoint takes the secret
only on stdin while relay is stopped, syncs the catalog and grants the existing
YLZ administrator. It does not grant all registered accounts or reset old quotas.

Verification lives in `remote-relay/tests/model-quota.test.mjs` and
`model-console.test.mjs`. Loopback executor tests use an isolated HTTP fixture;
they are not evidence of paid-provider or native Desktop acceptance.
