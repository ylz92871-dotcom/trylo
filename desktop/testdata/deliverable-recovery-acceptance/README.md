# Deliverable recovery acceptance fixture

Uses production result normalisation, ArtifactStore, ConversationResultRepository,
ResultDock, ArtifactPreviewStrip and WorkResultContent. All input records are
synthetic; browser paths follow the viewport producer's actual naming structure.
The 501-record recovery case intentionally loses the report's ID from the first
200 historical delta IDs, so merely filtering the visual list cannot pass.
Recovery must conservatively report this file as discovered, never as newly
created. The separate real Store/Repository case retains actual creation facts.

Run from the repository root:

```text
node desktop/scripts/verify-deliverable-recovery.mjs
```

Evidence is written below `_workspace/tasks/deliverable-ui-recovery-20261108/`.
This is an isolated component render, not production App, native Tauri, installed
package or real-provider acceptance. No real user data/files or desktop control
is used. File actions are bounded synthetic callbacks; no PDF is read or opened.
