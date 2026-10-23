# Unified account service

Production entrypoints: https://trylocode.me/account/ and https://trylocode.me/admin/.
The promotional homepage is still served by the previous static-site container.
Account APIs and console assets are routed to the existing relay service. No DNS
record, existing tunnel hostname or provider configuration was changed.

## Code ownership

- `src/accounts.mjs`: invitation-gated identity, web/operator sessions, server
  role checks, admission limits, account reads and browser device authorization.
- `src/store.mjs`: SQLite WAL transactions. It imports the prior `state.json`
  once, preserves original JSON bytes and writes only `accounts.sqlite` afterward.
  Current schema deliberately stores a bounded relay-state snapshot in one row,
  maintaining legacy record shapes. It is a single-service implementation, not a
  normalized analytics database or a claim of multi-worker scaling.
- `src/server.mjs`: native login/refresh, owned devices, relay traffic and shared
  authorization enforcement. Production native registration also consumes the
  same invitations. The old shared environment invite is not accepted in production.
- `../trylocode-site/console`: real user/admin applications and neutral web styles.
  `prototypes/account-console-v2` remains an unchanged design reference.
- `../desktop-services/src/remote/relay-client.mjs`: private native credential
  storage, browser proof verifier, credential exchange, validation and renewal.
  Renderer receives an attempt ID, public verification code and URL only.

## Session and device contract

There is one user identity and password record across website and Desktop.
Usernames are normalized to lowercase. The existing `ylz` identity was explicitly
selected by the owner for administrator access; its ID/password/device identity
were retained. There is no public first-user administrator rule.

| Session | Lifetime | Transport | Scope |
| --- | --- | --- | --- |
| User web | 7 days | `__Host-trylo-web`, Secure/HttpOnly/SameSite=Lax cookie | Own account, metadata, devices and authorization confirmation |
| Operator web | 2 hours | Independent `__Host-trylo-admin` cookie | Server-checked admin role on every management request |
| Desktop account | 7 days | Private bearer credential | Owned relay devices; renewable with token rotation |
| Paired phone | 30 days | Device-bound bearer credential | Its paired Desktop only |

Web POST/DELETE require the exact configured Origin, JSON content type and a
session-bound CSRF token. Login/register also check Origin, preventing login CSRF.
Web cookies cannot be used as native bearer credentials or in the opposite web scope.
Session identifiers, proof verifiers and invitation values are hashed in server state.
Full invitation values are shown once at issuance; listings expose suffixes only.

Website logout revokes that website session only. Operator logout is independent.
Desktop logout revokes its own device and paired phones, then its account token.
Website device removal terminates the relay socket and revokes bound phone and
native account sessions. Unambiguous legacy one-Desktop account sessions are bound
during migration; ambiguous multi-device legacy tokens require re-login rather
than guessing ownership. Relogin with retained Desktop registration proves its
device secret and binds the replacement account session to that same device.

Native status queries validate authority against `/relay/account`. A bounded
5-minute monitor also detects revocation and rotates credentials when less than
one day remains. Remote socket termination is immediate; account UI invalidation
can lag up to the next check. Temporary network failures do not erase credentials.
Expiring/expired sessions require login if renewal cannot happen before expiry.

Browser login: Desktop starts a 10-minute request with a SHA-256 proof challenge;
the web user checks a 12-hex-digit public code and explicitly approves or denies.
The verifier and private device code remain inside Service Host. Polling starts
at 5 seconds and honors slowdown. Exchange is single-use and bound to the proof.
Web confirmation alone never enables remote access or approves local tools.
This is a product-specific device authorization flow inspired by RFC 8628, not an
assertion of a complete interoperable OAuth authorization server.

## Limits and deliberately unavailable features

Invitation consumption, account creation and session issuance commit together.
Revoked/expired/exhausted invitations fail for both web and native registration.
Admins can pause registration, set 1–1000 total accounts and 1–50 devices per
account; a new invitation grants 1–100 uses for 1–90 days. Existing records are
not deleted when limits are lowered. Audit history is bounded to 5000 records.
Authentication concurrency, request/frame sizes and relay in-flight operations
remain bounded for the small host. Current rate limiting is conservative per
socket peer; behind the shared ingress that can be a shared limit.

Unified model forwarding is **not enabled**. No provider secrets, paid model
requests, fake balances or sample usage were added. Quota starts at zero and
model/usage responses reflect no activated service. Model budget reservation,
provider reconciliation, paid entitlements, relay traffic budgets, recovery and
MFA are separate future work, not enforced features claimed by this release.
Custom local Desktop API settings remain independent.

## Deployment and recovery

Node >=22.13 required for the built-in SQLite API. Production observed Node 22.23.3.
Data is on the existing `trylo-relay_relay_data` Docker volume. The canonical
`/home/ubuntu/trylo-relay/compose.yaml` pins the current image and build release.
`/home/admin/trylo-accounts/current-release.txt` identifies the live release;
versioned release metadata and restricted pre-update backups live alongside it.
No private keys, passwords or raw account data are copied to public artifacts.

First rollout helper: `scripts/deploy-seoul-accounts.py`. Subsequent release helper:
`scripts/update-seoul-accounts.py`. Both verify archive and expected ingress hashes,
retain the volume, preserve backups and health-check before accepting the rollout.
The normal `docker compose up -d --no-build relay` now uses the pinned release.
Do not rebuild from an obsolete release or run old JSON writers against migrated
accounts. A 0.2.x rollback can use the retained SQLite state; returning to 0.1.x
requires a write freeze and explicit export/migration plan, otherwise new accounts
and sessions would be lost because `state.json` is intentionally frozen.

## Acceptance evidence

`evidence/account-sync-20261023/` records source/HTTP/browser review and public
asset/runtime hashes. Tests exercise migration identity, atomic invitations,
CSRF, scoped sessions, proof binding/expiry/replay/denial, token renewal, device
ownership, removal, revocation and relay reconnection without task replay.
Browser UI + actual private Desktop-client exchange passed with isolated local
fixtures. Actual Service Host NDJSON methods successfully start/cancel production
authorization without exposing private credentials to the renderer.

These are distinct from real-user password entry, native Tauri/WebView2 UI and
real phone acceptance. The owner was asked to sign into the production admin page
with the existing password; credentials are never requested in chat. Native dev
prefers `desktop-services/src/host.mjs`, so restart the development Desktop to
load the new host methods; installed releases need a new packaged runtime.

References: [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628),
[OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
