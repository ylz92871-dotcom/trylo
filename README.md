# Trylo

[English](README.md) | [简体中文](README.zh-CN.md)

Trylo is a personal learning agent project with a native desktop application, a TypeScript CLI, a Work surface, and an Android remote workbench.

**Status: alpha.** Desktop 1.0.4 preview downloads include the current CLI permission fixes. Android 1.6.0 is the unchanged signed artifact built at desktop-v1.0.2. Engineering checks and packaged-process tests are recorded separately from native UI, real-provider and device acceptance.

Downloads: [Windows Desktop and checksums](result/desktop/) · [Android APK](result/mobile/). The Desktop preview defaults to its bundled legacy compatibility CLI; Settings can switch to the bundled new CLI and back. CoWork is a separate optional dependency.

The October 20 update repairs runtime integrity, contained absolute file paths, input diagnostics and context handoff when switching CLI engines, and synchronizes mobile connectivity and current tool source. See the [release record](docs/release/DESKTOP_1_0_3.md) and [source checkpoint](docs/release/CURRENT_SOURCE_CHECKPOINT.md).

## Source map

| Directory | Responsibility |
| --- | --- |
| [new trylo cli](new%20trylo%20cli/) | Trylo CLI/TUI, execution, protocol, permissions, session recovery, and learning |
| [desktop](desktop/) | React + Tauri desktop application |
| [desktop-services](desktop-services/) | Local service host, tooling, browser, remote, and companion services |
| [new_tool](new_tool/README.md) | Windows-MCP fork source, tooling provenance and pinned dependency setup |
| [work](work/) | Workflows, managed-runtime adapters, and deliverables |
| [mobile-app](mobile-app/) | Android application and remote workbench |
| [trylocode-site](trylocode-site/) | Website source |
| [docs/architecture](docs/architecture/README.md) | Module boundaries, ownership, current wiring, and target structure |

The product architecture treats user learning, agent learning, and execution as distinct concerns. Learning proposals and evidence do not grant execution permissions. The architecture documents distinguish intended mechanisms from implemented and verified behavior.

## Development

Each application retains its existing manifest and lockfile. In the new CLI directory, install the locked dependencies with `npm ci`; `npx tsc -p tsconfig.json --noEmit` checks the TypeScript source.

For a Windows x64 CLI build, first run `node scripts/setup-cli-native.mjs --install` from the repository root, then `npm ci` and `npm run build` inside `new trylo cli`. The tracked PTY helper and digest-verified sandbox download are documented in [source build instructions](docs/development/build-from-source.md). Desktop packaging stages the CLI, Node, services, and native sidecars. Some of these acquisition/build steps still depend on local inputs and are being made reproducible. The repository is not yet a one-command clean-clone release build.

## Current limits

- Production Desktop builds default to `legacy-stream-json` with both CLI engines bundled. Building the compatibility component requires an explicit inventoried artifact; its old source is excluded from this repository.
- Work's existing vendor/build closure and tests tied to historical evidence still need cleanup.
- The directory preview is a proposal, not the active runtime layout.
- Native desktop, installed artifacts, and Android device acceptance are recorded separately from source checks.

See [checkpoint details](docs/release/CURRENT_SOURCE_CHECKPOINT.md), [architecture](docs/architecture/README.md), and [migration order](docs/development/repository-layout.md).

Only the new CLI source is included. The legacy CLI, proprietary CLI distributions, research checkouts, credentials, raw sessions/recordings, and local build caches are excluded. Third-party components retain their own licenses and attribution.

First-party project code follows [Apache-2.0](LICENSE); see [NOTICE](NOTICE) and component-level provenance. Source updates, website deployment, and binary releases are separate operations.

Tool source restoration and checks: [2026-10-15 source audit](docs/release/SOURCE_COMPLETENESS_2026_10_15.md). From the repository root: `node scripts/release/check-source-completeness.mjs`; dependency setup: `node scripts/setup-repository-tools.mjs --install`.

Current source synchronization: [current checkpoint and verification](docs/release/CURRENT_SOURCE_CHECKPOINT.md). Downloads: [Desktop](result/desktop/) and [Android](result/mobile/).

October 18 source synchronization merges the public context fixes with formal memory, continuation diagnostics, Desktop pairing and mobile remote updates. See the [current source checkpoint](docs/release/CURRENT_SOURCE_CHECKPOINT.md).
