# Desktop account surface

The existing LeftRail avatar opens ProfileCard. Its default account view is ProfileAccountContent; the original nickname, bio, avatar presets and native image picker remain a secondary view. The adjacent settings control remains in place. RemotePairingModal links to the same avatar surface instead of collecting credentials.

AppShell owns `useDesktopAccount` for the lifetime of the application shell. Closing the popup does not cancel a browser login or restart its poll timer. Explicit cancel, server change and shell unmount invalidate outstanding work. Late status/begin/poll results cannot overwrite a newer flow. Pending authorization stays in memory; completed native credentials are owned and restored by Service Host.

The controller uses the existing browser authorization endpoints and native account store. Renderer results contain only account status, attempt ID, public verification URL/code, expiry and polling interval. Password, native access token, device code and verifier are not renderer state. Website and Desktop use one identity with separate sessions; local avatar/nickname/bio remain local profile data.

New RPCs `remote.relayBrowserOpen` and `remote.relayAccountOpen` launch the system browser through Service Host. The former accepts an active attempt ID rather than an arbitrary URL. The latter derives `/account/` from the authenticated session origin. Both preserve the existing server-origin checks. Failed OS launch leaves the public authorization handoff available for reopen/copy recovery.

Authentication never enables remote access. After an explicit login/logout, AppShell only pauses an already-enabled **server** remote connection; it does not switch connection mode or stop an independent tunnel. Initial session restoration does not apply that pause. Logout while server remote access is active explains the disconnection before executing.

Verification and preserved initial failures are under `desktop/spike-results/2026-10-23-account-popover/`. The browser fixture in `desktop/prototype/account-login-wired/` imports these real components and state machine with synthetic IO; it is not a production route or native-login acceptance.
