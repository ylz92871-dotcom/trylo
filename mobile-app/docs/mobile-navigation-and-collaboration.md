# Mobile navigation and collaboration — 2026-11-16

This is a refinement of the existing Trylo mobile app, preserving its neutral surfaces, restrained gold, Code/Work ownership and direct model connections.

The existing styles remain the visual source of truth: `src/remote/workbench.css` owns remote surfaces and semantic status colors; `src/refresh.css` applies the neutral Ionic/direct-chat appearance over `src/theme.css`. Both retain light/dark adaptation. This extension adds no separate palette, typography system or design-system files.

The confirmed first-use destination is a task/conversation home. A new user can choose phone chat or connect a computer immediately. Demo content is an explicit secondary choice. Connected users see pending reviews and recent conversations. Home, Chats, Inbox and Devices remain stable destinations; the conversation keeps readable dialogue by default and exposes process details on demand.

Phone chat has a compact single-row header and one primary provider-connection action, with provider/key/model steps and a direct-request/local-history explanation. Its component remains mounted when visiting the remote workspace, preserving drafts and in-flight replies. In the remote conversation, reading results, process details or team details hides the message composer.

Teams stay attached to a Code or Work conversation. The composer always offers Solo. Desktop-provided team templates appear when Desktop permits Team Access; otherwise the picker explains how to enable it, while existing members remain readable. Selecting a template changes that conversation's composer choice until changed again; it starts no work. Sending invokes Desktop's existing frozen-profile Team Access launch and native supervisor. Solo still allows the main agent to delegate subtasks. The same phone components serve Code and Work.

The Members entry opens actual children/seats with task, state, response and round history; configured but unjoined roles are not progress rows. Member identities, stable rows across resume and round history come from the Desktop conversation reducer; the phone never reconstructs them from raw invocation events. Remote projections carry session identity, clear members on selection and restore them from Desktop history after reconnect. Drafts, attachments and collaboration choices stay in phone UI state, keyed by computer/project/conversation; reading position also distinguishes pane and display mode. These are not execution state. Offline excerpts remain read-only and tied to their original computer and conversation; remote sending and approval decisions require a live connection.

Borrowed interaction patterns:

- [Slack mobile](https://slack.com/help/articles/56387669632147-Getting-started-for-Frontline-members): a stable conversation destination and a separate attention destination.
- [Linear mobile](https://linear.app/docs/get-the-app): a focused home/inbox structure that complements desktop work.

No new execution engine, permission bypass, account model or visual brand is introduced. This change does not alter model keys or the requirement to connect a provider for direct chat. Native device acceptance and an APK release remain separate from browser and contract validation.

Local validation and screenshots: `_workspace/tasks/mobile-ux-team-20261116/` at the repository root. Screenshots of team runs use the production local gateway with synthetic Desktop authority; no model or shell command executes in the fixture. `finish-review.md` records the screenshot scope; `finish-verdict.md` resolves its sole resume-identity finding through targeted source and regression review, without claiming new runtime screenshots or native acceptance.
