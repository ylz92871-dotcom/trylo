# Trylo account console

Production-facing user and administrator entrypoints served by [remote-relay](../../remote-relay). Authentication, sessions, invitations, account data, usage records, device ownership and administrator mutations use its real backend; this directory has no fixture account store.

## Run locally

Requires Node.js 22.13 or newer. For disposable local browser integration, use
the explicit loopback harness; it creates synthetic accounts, never production data:

```powershell
Set-Location D:/CC/trylo/remote-relay
node scripts/dev-accounts.mjs D:/CC/trylo/output/account-sync-local-20261023
```

Open `http://127.0.0.1:5197/account/` or `http://127.0.0.1:5197/admin/`.
The synthetic harness account is `ui.operator` / `local-ui-test-password-123`.
Do not deploy the harness or reuse its fixture credentials. Production uses HTTPS,
Secure cookies, existing account provisioning and the deployment described in
[ACCOUNT-SERVICE.md](../../remote-relay/ACCOUNT-SERVICE.md). A static-file server
alone cannot provide these APIs. Backend checks run with `npm test` in `remote-relay`.

## Routes and sources

| Route | Source / purpose |
| --- | --- |
| `/account/` | `user/index.html`, `user/app.js`: overview, usage, models, devices, settings; login/register; Desktop authorization and connection steps |
| `/admin/` | `admin/index.html`, `admin/app.js`: invitations, users, resource limits and audit records; independent administrator session |
| `/console/user/*`, `/console/admin/*`, `/console/shared/*` | Allowlisted assets served by `../../remote-relay/src/web.mjs` |
| `/api/account/*`, `/api/admin/*` | Real account and administrator services in `../../remote-relay/src/accounts.mjs` |

Page selection uses URL hashes (`#overview`, `#usage`, `#models`, `#devices`, `#settings`; administrator `#invitations`, `#users`, `#resources`, `#audit`). Desktop confirmation uses `/account/#authorize?code=…`.

`shared/api.js` provides same-origin requests and session CSRF handling. `shared/ui.js` provides icons, escaped text, status, toast and confirmation dialogs. Confirmation awaits asynchronous mutations before closing, then restores focus to the surviving trigger or the page heading after rerender.

## Visual inheritance

This is an extension of the approved [account-console-v2](../prototypes/account-console-v2/) visual system. Its [DESIGN.md](../prototypes/account-console-v2/DESIGN.md) and [.impeccable/design.json](../prototypes/account-console-v2/.impeccable/design.json) remain the design references. No replacement design system is introduced here.

SHA-256 comparison on 2026-10-23 confirms all three stylesheet files are byte-for-byte identical to their v2 counterparts:

| File | SHA-256 |
| --- | --- |
| `user/style.css` | `90CC02113DB679D0054EB288D3EAB310E1B58B117258D8A454AE8818E9F41436` |
| `admin/style.css` | `6EBC51F9894B3FEB26B0BDCF57C6CBECAA00330CB12130020BC89E085C282A87` |
| `shared/base.css` | `252873B430CC5BAE24D21CDE5C6FA1336E8E8B84811ABD7C0242C7FB1A8BD828` |

The v2 prototype and its preview fixtures remain design/demo references. Their sample data is separate from these production entrypoints and must not be treated as account or service evidence.

## Acceptance boundary

The AMD free-pool backend is enabled as of 2026-10-25. Catalog, encrypted credentials,
account grants, request quotas and unary/SSE Chat are connected to the real upstream.
All 15 catalog entries are retained; 10 declare Chat capability, while the 5 audio,
OCR or decision entries require dedicated routes. The owner YLZ has a 1000-request
daily grant, other accounts require administrator authorization. The published
Desktop 1.0.6 provider selector still has no platform-model integration. Backend
acceptance does not establish new native-window or real-phone acceptance.
The current Desktop source and staged Service Host now synchronize authorized
text models and execute through the same quota service. Two encrypted AMD API
accounts rotate behind one grant; specialists stay in this console. Actual staged
CLI text and read_file continuation passed. The distributed installer is unchanged.
