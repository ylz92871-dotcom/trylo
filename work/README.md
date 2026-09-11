# Trylo Work

The **Work sub-app** of Trylo Desktop.

This is one of two sub-apps inside the Trylo Tauri shell:

| Sub-app | Where it lives | What it does |
|---|---|---|
| **Code** | `../desktop/` | IDE — Monaco editor, file tree, LSP, agent chat for code work. Uses Trylo's existing `trylo-runner.ts` (CLI). |
| **Work** | `./` (this folder) | Document / spreadsheet / presentation / web artifacts. Generates `.docx`/`.xlsx`/`.pptx`. The "ChatGPT work mode" feel. |

The two sub-apps are independent at the runtime level — they don't share code or process state. They share:
- The Tauri shell (window, menu, tray).
- The design system (`../desktop/src/styles/tokens.css` — Trylo gold/charcoal).
- The workspace path (whatever folder the user opened in Code mode is also the workspace for Work mode).

## Architecture

```
Trylo Tauri shell
├── Code sub-app      ──►  TryloRunner (existing)
└── Work sub-app      ──►  trylo-workd (this package, Node sidecar)
                              │
                              ├─ Control Plane (HTTP/WS)
                              ├─ agent runtime (Phase 1: from coworker)
                              ├─ MCP / Skills / Memory (Phase 1)
                              └─ docx/xlsx/pptx generation (Phase 1)
```

The Work sub-app is a **Node sidecar process** spawned by Tauri. The Tauri webview talks to it over a local HTTP API called the **Control Plane** (designed to be wire-compatible with CoWork-OS's `coworkd` once Phase 1 lands).

## Source layout

```
work/
├── README.md                 # this file
├── STRUCTURE.md              # what's in here now vs what Phase 1 adds
├── package.json              # @trylo/work package
├── tsconfig.json             # for Phase 1+ (TS sources)
├── bin/
│   └── trylo-workd.mjs       # daemon entry (Phase 0: stub, Phase 1: coworkd wrapper)
├── src/
│   ├── daemon/               # Trylo's wrapper around coworkd (Phase 1)
│   ├── control-plane/        # HTTP/WS API server + client (Phase 1)
│   ├── renderer/             # React renderer for the work surface (Phase 2)
│   ├── shared/               # Trylo-specific types (FilePath, WorkspaceRef, ...)
│   └── host-adapter/         # the bridge Tauri uses to call into the daemon
├── vendor/
│   └── cowork-os/            # Phase 1: CoWork-OS source copied in, unmodified
└── tests/                    # vitest specs (Phase 1+)
```

## Running independently

Phase 0:

```bash
cd C:/work/demo-ws/work
node ./bin/trylo-workd.mjs
# in another shell:
curl http://127.0.0.1:47821/health
curl -X POST -d '{"hello":"world"}' http://127.0.0.1:47821/v1/echo
```

The daemon listens on `127.0.0.1:47821` by default. Override with env vars:

- `TRYLO_WORKD_PORT` — port (default `47821`)
- `TRYLO_WORKD_HOST` — bind host (default `127.0.0.1`)

## Why a separate package

Trylo's `desktop/` is a Tauri + Vite frontend. Work's daemon is pure Node + (later) a React renderer. Mixing them in one `package.json` would force the Tauri build to drag in the daemon's deps, and vice versa. Keeping `work/` as a sibling package means:

1. The daemon can be developed and tested without launching Tauri.
2. The Tauri build stays small.
3. The fork from CoWork-OS lives in a clearly bounded place (`vendor/cowork-os/`).
4. Future contributions can target `work/` without touching `desktop/`.

## Vendor patches

`vendor/cowork-os/` is a supply-chain copy and is **git-ignored by default**.
Trylo keeps only its reviewed compatibility/runtime patch files visible to Git
so a fresh checkout cannot silently lose the integration fixes:

- `src/electron/control-plane/task-event-bridge-contract.ts` extends the event
  allowlist with `llm_usage` and `context_compaction_started|completed|failed`.
- `src/daemon/control-plane-methods.ts` returns the new task id before
  execution begins, forwards follow-up permission/shell fields, and
  acknowledges long-running continuations immediately instead of holding an
  RPC open until the whole task finishes.
- `dist/daemon/daemon/control-plane-methods.js` is the compiled runtime copy
  used by `coworkd-node.js` when the daemon has already been built.
- `src/runtime/managed/*` is the headless-safe solo ManagedSession core used by
  the daemon and the Electron facade.
- `src/electron/managed/ManagedSessionService.ts` composes that core for solo
  sessions while retaining team/studio/media concerns in the Electron shell.
- `src/electron/media/media-token-store.ts` keeps token generation independent
  from Electron protocol registration so ManagedSession tests can load in Node.
- The corresponding daemon/Electron compiled files under `dist/` are retained
  because the packaged launchers may execute an already-built vendor runtime.
- `../desktop-services/vendor/legacy/remote-gateway/index.js` carries the
  additive Trylo P3 patch (2026-09-06, no longer byte-identical): `surface`
  forwarding in `POST /v1/chat/messages` plus read-only `GET /v1/artifacts`
  and `GET /v1/artifacts/content?path=` (Desktop-authored, gateway only
  sanitizes shapes and streams bytes; 12MB content cap). `no-external-paths`
  and `smoke:legacy-gateway` still pass; artifact routes are covered by
  `desktop-services/tests/services/remote-gateway-artifacts.test.mjs`.

The corresponding exceptions live in the repository `.gitignore`. When the
upstream checkout is refreshed, reapply and review these files, run both
`npm run build:daemon` and `npm run build:electron`, then run Trylo's vendor
protocol and ManagedSession contract tests.

## License

The vendor content under `vendor/cowork-os/` retains its original CoWork-OS MIT license (see `vendor/cowork-os/LICENSE` after Phase 1 copies it in). Everything else in this folder is Trylo's.
