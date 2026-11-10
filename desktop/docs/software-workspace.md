# Background software workspace

Status: implementation, 2026-11-10. Native acceptance is recorded separately.

The shared AppShell exposes one software dock in Code and Work. It shows the
actual application beside the conversation, with application/window selection,
freshness, a separate SOLIDWORKS model view, manual takeover, refresh, expansion
and explicit stop. Closing the dock only hides it; stopping the workspace closes
its owned applications and loses unsaved changes. Save through the application
API before stopping. No main-desktop attachment, mouse movement or focus fallback.

The Service Host owns conversation scopes, capabilities and control leases. The
existing CLI remains the sole execution and approval authority. The new MCP
surface is classified by the existing router; read-only denies writes, automatic
mode admits the authorized tools, and an explicitly disabled computer capability
does not mount this surface. Existing CAD tool schemas and classifiers remain
unchanged. Their transport places the server on the same hidden desktop. A COM
guard validates the application PID and refuses COM service-manager launches or
attachment to another instance. It does not replay failed/unknown writes.

Native ownership uses a unique Win32 desktop and kill-on-close process job. The
controller starts a worker, assigns the job, then releases its bootstrap. Child
applications and API servers inherit ownership. EOF, explicit stop, isolation
failure or Host exit releases the job. Existing desktop applications are never
terminated. Session loss is visible and requires a new explicit start. This is
window/input placement isolation, not an account/filesystem security sandbox.

Frames are pull-driven, one request at a time, only while the dock is visible.
The 2 MiB Service Host frame limit constrains JPEG encoding. Screenshot and input
pixels share the application's DPI context, including legacy DPI-unaware apps.
Hidden desktops do not render every GPU surface through GDI;
SOLIDWORKS uses its native image export for its model view. Model images are
read-only; click interaction belongs to the software-window view. Posted input
is application-dependent and returns a delivery receipt, not an acceptance claim.
User takeover stops admission of new model writes, waits for the active API call
to complete, and then admits scoped user input. While waiting, explicit user
input can target an observed owned modal dialog, so a blocked API call can finish;
the native worker rechecks that it is still a dialog before posting input.
It does not interrupt/replay the active modeling command. Dialogs remain visible to the
user/model; authentication or security decisions are not automatically accepted.

## Interface direction

The user is following a model-building task while reading its event stream.
The canvas is the focal element; compact chrome keeps the conversation legible.
Domain cues: drawing sheet, viewport, application tab, view orientation, control
handoff and saved document. Palette: existing paper, warm gray, graphite, muted
gold and success green tokens. Signature: a quiet bottom control strip binds the
visible window, freshness and current operator. Avoid a dashboard-card grid,
decorative CAD graphics and fake live/FPS claims. Use the existing shell rail,
spacing, typography, border depth, light/dark tokens and keyboard focus treatment.

Verification covers actual Code/Work callers, disabled/automatic/read-only
classification, scope isolation, takeover during API calls, stop/disconnect,
native fixture input, real installed CAD applications, real image content,
Default-desktop isolation, packaged asset closure and rendered UI states.
