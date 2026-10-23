<div align="center">

<img src="desktop/src-tauri/icons/128x128@2x.png" alt="Trylo logo" width="88" height="88" />

# Trylo

**A personal learning agent for long-term collaboration.**

Turn ideas into deliverables. Keep useful collaboration experience for the next task.

[简体中文](README.md) · [English](README.en.md)

**[Download Desktop](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.6) · [Download Android](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo-Code-v1.6.0.apk) · [Architecture](docs/architecture/README.md)**

Windows Desktop 1.0.6 · Android 1.6.0 · Alpha · Apache-2.0

</div>

## Trylo宣传视频

A 4-minute, 34-second look at task execution, computer interaction, and personal learning.

https://github.com/user-attachments/assets/3dadb313-565c-49b6-8e07-6038dbb2fcfd

[Download Trylo宣传视频 · original 1080p video](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo.mp4)

## A workspace to keep work moving

Open a project, describe the goal, and continue from its files and existing tasks. Trylo brings conversation, tool calls, file changes, and results into one workflow.

![Trylo native desktop workspace](docs/images/showcase/desktop.png)

| Execute tasks | Understand your working style | Reuse experience |
| --- | --- | --- |
| Read and edit files, run commands, and connect browser and computer tools. | Enable user learning to inspect evidence and correct collaboration preferences. | Review proposed memories and skills before adopting them. |

## Follow the work, down to the changes

Write code, organize documents, inspect web pages, or use computer tools to interact with desktop applications. Expand tool inputs, outputs, and execution status to inspect what happened.

![Tool execution and browser operation details](docs/images/showcase/tools.png)

Review file diffs and open the resulting files to check the work directly.

![File changes in the task workflow](docs/images/showcase/diff.png)

## Learning you can inspect and control

Trylo separates **user learning**, which concerns collaboration preferences, from **agent learning**, which manages proposed memories and reusable skills.

User learning is explicitly enabled. Inspect its evidence, correct preferences, and choose whether to observe, apply, or disable them.

![Controls for observing, applying, or disabling preferences](docs/images/showcase/learning-controls.png)

Memory and skill proposals enter a review queue. Read the full content and changes before approving or rejecting them. Learning approval and execution permissions are separate: approving a skill does not grant tool access.

![Memory and skill approval queue](docs/images/showcase/learning-approval.png)

## Desktop, terminal, and phone

| Surface | Role |
| --- | --- |
| **Desktop** | Native workspace for projects, tasks, tools, learning, and results. |
| **CLI / TUI** | Terminal execution, tools, session recovery, and learning; the new TypeScript CLI source is included. |
| **Android** | A paired remote workbench for viewing and continuing desktop tasks; requires the desktop service and network connectivity. |
| **Local services** | File, shell, browser, and Windows computer tools, subject to installed components, model support, and permission settings. |

CoWork remains a separate optional dependency, outside the core desktop package.

## Get started

1. Download the Windows installer or portable package from [Releases](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.6).
2. Open a workspace, configure your model provider and credentials, and select appropriate tools and permissions.
3. Start with a project question, a code change, or a document task. Explicitly enable learning when you want to use it.
4. For remote access, install the Android app and follow the desktop pairing instructions.

| Download | Version |
| --- | --- |
| [Windows x64 installer](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/Trylo_1.0.6_x64-setup.exe) | Desktop 1.0.6 |
| [Windows x64 portable](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/Trylo-Desktop-1.0.6-windows-x64-portable-core.zip) | Core package; CoWork separate |
| [Android APK](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo-Code-v1.6.0.apk) | Android 1.6.0, existing signed build |
| [SHA-256 checksums](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/SHA256SUMS) | File integrity checks |

**Alpha status.** Desktop 1.0.6 bundles and defaults to the new Trylo CLI only. Legacy CLI selections migrate to trylo-v1; the legacy engine and CoWork runtime are excluded. This build includes the product source synchronized on October 24. See the [checkpoint](docs/release/CURRENT_SOURCE_CHECKPOINT.md) and [release record](docs/release/DESKTOP_1_0_6.md) for verification boundaries. Screenshots and demos do not establish support for every model, application, or device combination.

## Explore the source

| Directory | Responsibility |
| --- | --- |
| [`desktop/`](desktop/) | React + Tauri native application |
| [`new trylo cli/`](new%20trylo%20cli/) | TypeScript CLI/TUI, execution, protocol, permissions, context, and learning |
| [`desktop-services/`](desktop-services/) | Local Service Host, tooling, browser, and remote services |
| [`new_tool/`](new_tool/README.md) | Windows-MCP fork, provenance, and dependency setup |
| [`work/`](work/) | Workflows, runtime adapters, and deliverables |
| [`mobile-app/`](mobile-app/) | Android remote workbench |
| [`trylocode-site/`](trylocode-site/) | Website source |

[Architecture](docs/architecture/README.md) · [Build from source](docs/development/build-from-source.md) · [Repository layout](docs/development/repository-layout.md) · [Recent CLI fixes and verification](docs/release/NEW_CLI_DEBUG_2026_10_22.md)

New CLI build on Windows x64 with Node.js ≥ 22:

```powershell
# From the repository root: explicitly prepare pinned native dependencies.
node scripts/setup-cli-native.mjs --install
cd "new trylo cli"
npm ci
npm run build
```

A complete Desktop release build needs additional runtime artifacts and manifests; see the [build instructions](docs/development/build-from-source.md). Source checks, real-provider runs, native UI, and installer acceptance are documented separately.

## Open source

First-party code uses [Apache-2.0](LICENSE). Third-party components retain their own licenses and attribution; see [NOTICE](NOTICE). Legacy CLI source, credentials, and local build caches are excluded. Reproducible [issue reports](https://github.com/ylz92871-dotcom/trylo/issues) and pull requests are welcome.
