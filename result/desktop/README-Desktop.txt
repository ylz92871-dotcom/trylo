Trylo Desktop - public source build

Default engine: the new Trylo CLI, using the trylo-v1 protocol.
CLI entry: cli/dist/cmd/trylo/main.js
Node: bundled under runtime/node/win-x64.

Extract the entire archive and launch Start-Trylo.cmd. It prepares the bundled
executables to match the launcher's existing authority: normally Medium, or
High only when you already explicitly launched it elevated. It does not
request admin or grant a token. This prevents Low-labelled extraction folders
from disabling tool input and ordinary file writes.
Keep the resource
folders beside the executable. Configure your own provider/model in Settings.
Code and ordinary Work share the new CLI. CoWork is a separate experimental
dependency; no old CLI engine is included in this core distribution.

Tool dependencies are prepared through the pinned tool-package installer and
health checks. Browser bodies and CAD host applications have their own setup.
Source validation does not replace native or real-provider acceptance.

This README describes builds made from the current source. Previously published
Desktop R3 downloads retain their recorded bytes, legacy default and checksums.
