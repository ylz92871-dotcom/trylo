# Model-service administration view

Reusable UI for configuring existing API upstreams and granting selected Trylo
accounts access. The administrator app uses `api-client.js` to reuse its existing
session and CSRF handling and the relay's quota APIs. The view also accepts the
isolated preview client. Production with the explicit AMD flag provides separate
credential rotation and full catalog refresh actions for the pinned AMD free pool.
The preview still rejects real credentials. Other adapters remain unavailable.

`index.js` exports `mountModelService(root, {client, preview, page, onPageChange})`.
`style.css` is scoped under `.model-admin`; load the existing shared base and
administrator stylesheet first. Shared icon, status, escaping, toast and async
confirmation implementations are imported from `console/shared/ui.js`.

The injected client returns `{upstreams, users, grants}` from `load`,
`saveUpstream`, `setUpstreamEnabled`, `saveGrant`, and `revokeGrant`. Mutations
return a fresh snapshot. The view has no fetch, storage, URL routing, account
login or token implementation. Production wiring should adapt existing
`shared/api.js` and existing administrator authorization, not introduce a second
account store or copy this view into another page. Client-side controls do not
replace server-side permissions, validation, credential encryption or accounting.

The preview port lives only in `prototypes/model-upstreams-v1/preview-client.js`.
It uses synthetic users and memory-only data, makes no API calls, rejects secrets
and clears on reload. Its credential field is disabled. No provider endpoint,
protocol capability, real quota, test result, or model availability is established
by this preview. Free allowance and subscription APIs are both existing API
connections; this design does not convert product subscriptions into APIs.

The relay implements grants, shared and individual quota, reserve/settle accounting,
and fixed Trylo accounting windows. AMD request-count Chat unary/SSE execution and
encrypted, endpoint-bound credentials are implemented. Audio/OCR/decision catalog
entries retain their capability labels and do not pretend to be chat models.
Other provider adapters and official quota queries remain separate work. Current
Desktop source synchronizes granted text models through the Service Host; the
published 1.0.6 installer still needs rebuilding. Daily 1000 requests are per
granted account across all pool models and both encrypted AMD account slots.
The existing credential editor can replace primary or secondary independently;
provider keys are never returned to the browser. Rotation does not replay calls.
Endpoint changes must never silently forward a retained
secret to a new host. Editing quota units/periods with existing grants needs a
server-enforced migration rule, not reinterpretation of historical usage.
An existing grant's account/upstream identity is immutable. Both UI controls and
the client reject reassignment; the server enforces the same rule so
usage history cannot move to another user or be relabeled in another unit.
