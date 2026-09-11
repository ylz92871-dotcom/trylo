<div align="center">

<img src="desktop/public/logo/trylo-logo-final.svg" width="96" alt="Trylo" />

# Trylo

**Trylo Desktop — an agent host that learns how you work. Two sub-apps today: Code for the code, Work for the deliverable.**

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-4c8dd8)]()
[![Status](https://img.shields.io/badge/status-alpha%20%2F%20WIP-orange)]()

</div>

> **Status: work in progress.** The desktop client is an alpha in daily use. The `trylo` CLI is under active development and is **not** part of this repository. Interfaces and directory layout will move.

## The idea: an agent that learns you

Most agents start every session from zero — same questions, same corrections, same mistakes. Trylo's bet is the opposite: **the agent should accumulate a model of how you work**, and that model should be *earned*, not assumed.

The whole point of the design is that a wrong guess about you is worse than no guess at all. So learning is a pipeline with gates, not a vector store of vibes:

<p align="center">
  <img src="docs/images/learning-loop.svg" width="720" alt="The learning loop" />
</p>

**Evidence → Conclusion → User model → Policy.** Evidence is drawn from what you actually did — approvals, interruptions, mid-flight corrections, feedback on artifacts (`evidence.ts`, `evidence-grounding.ts`). Conclusions are induced from that. The model is per user *and* per project. Policy is what finally steers Code and Work.

Four gates sit on the way in:

- **Grounding** — inferred preferences are not evidence. Only observed behaviour counts (`evidence-grounding.ts`).
- **Scoping** — learning is isolated per project (`scope.ts`); habits from one workspace never become another's rules.
- **Shadow-first** — every policy dimension has three states, `enforced` / `shadow` / `off` (`policy.ts`). A new rule runs in shadow and is only promoted once it has been observed to be non-disruptive.
- **Brake** — when a preference is high-impact and still unsettled, the run doesn't start: `impact-check.ts` flags the impact and `decision-governor.ts` returns `pending_impact` instead of `ready`. Better to stop than to misread you.

All of it runs on your machine. The slower half lives in the `desktop-services` Node sidecar: `learning-loop-service`, `history-mining-service`, `shadow-runner`, `curation-service`, `pending-admin-service`. The code lives in `desktop/src/user-learning/`, `desktop/src/learning/` and `desktop-services/src/learning/`.

## What it is today: two sub-apps

| Sub-app | Where it lives | What it does |
|---|---|---|
| **Code** | `desktop/` | IDE — Monaco editor, file tree, LSP, agent chat for code work, driven through `trylo-runner` |
| **Work** | `work/` | Document / spreadsheet / presentation / web artifacts — generates `.docx` / `.xlsx` / `.pptx` |

The two sub-apps are independent at the runtime level — they don't share code or process state. They share the Tauri shell (window, menu, tray), the design system (`desktop/src/styles/tokens.css`), and the workspace path.

<p align="center">
  <img src="docs/images/code-surface.png" width="49%" alt="Code sub-app" />
  <img src="docs/images/work-surface.png" width="49%" alt="Work sub-app" />
</p>

Cross-device control: pair the Android app with the desktop over a QR code to watch tasks, send messages, and approve sensitive operations remotely.

<p align="center">
  <img src="docs/images/remote-pairing.png" width="300" alt="Remote pairing" />
</p>

## Architecture

<p align="center">
  <img src="docs/images/architecture.svg" width="860" alt="Architecture" />
</p>

The desktop client is an agent **host**, not an agent: it drives a locally installed agent runtime and MCP tools. One of those tools is [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — an AI-friendly CLI for Office documents that Trylo contributes to upstream.

At package time these ride along as Tauri resources: `desktop-services`, `work`, `workd`, `sidecars/desktop-companion` (the pet), `sidecars/hermes-capabilities`.

## Repository map

| Directory | Package | What it is |
|---|---|---|
| `desktop/` | `trylo-desktop` | Tauri client: React/TS front end + Rust shell |
| `desktop-services/` | `@trylo/desktop-services` | Node sidecar: service-host loop, learning loop, pet-chat, remote gateway |
| `work/` | `@trylo/work` | Work sub-app: `trylo-workd` daemon, control plane, deliverables |
| `mobile-app/` | `trylocode` | Capacitor mobile shell (Android) |
| `trylocode-site/` | — | Product website (Cloudflare Pages) |
| `docs/` | — | Fixtures used by the desktop host-adapter test suite |
| `scripts/` | — | Workspace helper scripts |

## Getting started

Prerequisites: **Node 22+** (for `desktop` / `desktop-services`; `work` needs 20+), pnpm, and a Rust toolchain (for the Tauri build).

```bash
# desktop client
cd desktop && pnpm install && pnpm tauri:dev

# desktop-services sidecar
cd desktop-services && npm install && npm start   # node src/host.mjs

# Work daemon
cd work && node ./bin/trylo-workd.mjs

# website (Cloudflare Pages, see DEPLOY.md)
cd trylocode-site && npm install && node deploy.mjs
```

## Tests

Each package carries its own suite:

```bash
cd desktop           && pnpm test   # vitest
cd desktop-services  && npm test    # node --test + pet-chain smoke
cd work              && npm test    # node --test (TS via register hook)
```

The desktop client also has `pnpm typecheck`, `pnpm lint`, and `pnpm format:check`.

## Not in this repository

- **The `trylo` CLI** — in development, not open-sourced yet.
- **The agent runtime** — install it locally; the desktop client adapts to it via `host-adapter`.
- **Internal docs** — architecture notes, audit reports, and specs were written as internal working documents and will be curated over time. Until then, the diagram above plus the comments in `desktop/src/host-adapter/` and `desktop-services/src/` are the best detail source.
- Third-party components (including vendored ripgrep) are attributed in [NOTICE](NOTICE).

## Contributing

Early days — the architecture is still moving. Issues and focused PRs are welcome; check the repository map to see where a change belongs. Surfaces that are still in flux (learning loop, team seats): open an issue before building against internals.

## License

[Apache-2.0](LICENSE). Third-party components are attributed in [NOTICE](NOTICE). The separately installed agent runtime keeps its own license and terms.
