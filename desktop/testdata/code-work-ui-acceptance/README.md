# Code / Work shell acceptance

Run from the repository:

```powershell
node desktop/scripts/verify-code-work-ui.mjs
```

The runner builds this fixture using the repository's existing esbuild and
Playwright packages. It launches the already managed Chromium binary with a fresh
profile, and serves only its own static build and synthetic project. Its source,
screenshots, profile, generated Markdown files and proof receipts live below
`_workspace/tasks/code-work-ui-unification-20261109/headless/`. It closes its own
browser and HTTP server. It never connects to a user's Desktop or browser, starts
a model request, or changes system permissions. In the restricted Windows tool
environment, the single runner entry needs the same process/network permission as
the other independent headless acceptance scripts.

The fixture imports production AppShell, RightRail, ChatPanel, InputBar,
ResultDock, CodeReviewPanel, WorkReviewPanel and FilePeek. Result selection and
request scope use the production `useResultReview`, `useDiffPreview` and
`result-review-state` helpers. GitDiffView uses the real Monaco editor; the five
worker entry points imported by production monaco-init are bundled unchanged.
Only unopened lazy Office/CAD/other preview branches remain external to this
Markdown/diff fixture. `index.html` also provides a maintained direct Vite entry;
the static runner avoids requiring Vite's development dependency scan.

Synthetic records cover current and previous turns, 37 real Markdown file paths,
a historical PDF, a rename source, a successful check and an HTML URL. The host port reads the
generated Markdown files from the isolated project and rejects paths outside it.
Its diff comparison data and URL/open actions are synthetic host responses. It
does not invoke native Git, external applications or tool services.

Checks cover the shared compact result entry and rail, preview/review return,
opening the same file again, genuine Monaco rendering, URL routing, long-path
scrolling, 480px light/dark layouts, late diff responses across Work sessions and
same-ID Code/Work navigation, scoped expansion preferences, and historical
results remaining accessible without a new-turn inline result. Both modes' file
pickers use the production review-file navigation helpers and retain historical
Markdown/PDF choices without converting them into this turn's delivery buttons. Screenshots are
part of the proof; all relevant source hashes must remain stable for a passing
run.

Composer checks exercise real rendered controls and record fake parent callbacks:
typing replaces Stop with a single send button; accepted synthetic sends clear
the fixture's controlled draft/attachment; Stop and permission changes call the
right surface handler. They prove component composition and presentation. They
do not prove the real attachment store's markSent operation, CLI dispatch,
permission enforcement, native process cancellation, provider behavior, or
installed-package adoption. The complete App is deliberately not mounted.

Original setup and selector failures are retained in the task directory. A green
receipt is a new run, never a rewritten historical failure.
