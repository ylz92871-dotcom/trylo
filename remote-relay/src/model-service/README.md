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

Production has **no provider executor or secret vault yet**. Model calls return
503 before reserving or making a request. Credentials remain disabled in the UI;
quotas and grants can be saved. Desktop custom APIs do not traverse this service
and are outside these allocations. The native authenticated quota endpoint exists;
the actual Desktop provider selection/streaming path is not integrated yet.

A future trusted adapter must implement `quote({source,model,payload})` with a
verified upper bound and `run({source,model,payload,signal})` returning
`{value,units}`. For a request metric, one invocation always costs one request.
For tokens, missing actual usage retains the quote. The quote must account for
the provider's input, output, reasoning/cache accounting and configured limits;
no universal characters-to-tokens estimate is assumed. The current port is unary;
streaming needs a metered adapter with disconnect and terminal-usage handling.
No automatic fallback to a different paid source is performed.

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

Verification lives in `remote-relay/tests/model-quota.test.mjs` and
`model-console.test.mjs`. Loopback executor tests use an isolated HTTP fixture;
they are not evidence of paid-provider or native Desktop acceptance.
