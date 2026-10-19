Trylo Desktop - dual-runtime core distribution

Default engine: legacy-stream-json (compatibility CLI).
Settings > CLI runtime can select trylo-v1 (new Trylo CLI) and switch back.
Both engines and a fixed Node interpreter are included. No system Node is required.
CLI entries: cli-legacy/cli.cjs and cli/dist/cmd/trylo/main.js.

Extract the entire archive and launch Start-Trylo.cmd. It prepares the bundled
executables to match the launcher's existing authority: normally Medium, or
High only when you already explicitly launched it elevated. It does not
request admin or grant a token. This prevents Low-labelled extraction folders
from disabling tool input and ordinary file writes.
Keep the resource
folders beside the executable. Configure your own provider/model in Settings.
Code and ordinary Work share the selected CLI. CoWork is a separate experimental
dependency and is excluded from this core distribution.

Approved new-CLI shell commands run with Desktop's current authority. Read-only
still blocks commands and writes. Standalone new CLI keeps its sandbox default;
--shell-isolation host is an explicit per-run choice, never a silent fallback.
The selected mode does not bypass Windows ACLs, UAC or disabled tools.

Tool dependencies are prepared through the pinned tool-package installer and
health checks. Browser bodies and CAD host applications have their own setup.
Source validation does not replace native or real-provider acceptance.

Building the dual-runtime distribution requires an inventoried legacy runtime
artifact supplied as TRYLO_LEGACY_RUNTIME_DIR (manifest.json and files.json).
The old CLI source is not part of the public repository. New CLI source and build
instructions remain in new trylo cli/. Third-party notices travel with artifacts.
