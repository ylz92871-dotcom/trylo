// Trylo Desktop — Tauri implementation of the Work sub-app's
// HostAdapter. See ../../../work/src/host-adapter/host-adapter.ts
// for the interface this implements.
//
// The four host actions are dispatched to Tauri commands defined
// in `src-tauri/src/commands/work_host.rs`. The Rust side is
// preferred over `@tauri-apps/plugin-shell` so we can:
//   - constrain allowed paths via Tauri's fs scope (no escaping
//     into the user's home directory unexpectedly)
//   - cross-platform "open with app" without JS plugin perms
//   - log every action to the host stderr for debugging
//
// M3 closure §9.3 (M3-P1-11): artifact paths come from the
// daemon/agent and are NOT trusted. The adapter is therefore
// BOUND to the current project root:
//   1. Every file action runs validateArtifactTarget() here and
//      throws a readable denial BEFORE any IPC round trip.
//   2. The root travels with the request (`allowedRoot`) and the
//      Rust side re-validates after fs::canonicalize — including
//      existence and symlink containment — and launches without
//      any shell string concatenation.
//   3. http(s) web artifacts skip the file gate; the Rust side
//      opens them in the default browser with the same no-shell
//      API and refuses anything that is not http/https.

import { invoke } from "@tauri-apps/api/core";
import {
  artifactDenialText,
  isHttpArtifact,
  validateArtifactTarget,
  type HostAdapter,
  type OpenWithApp,
} from "@trylo/work";

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return await invoke<T>(cmd, args);
}

/** §9.3 renderer-side gate. Throws a user-readable Error when
 *  the target must not be opened; otherwise returns the value
 *  to send as `filePath`. */
function assertFileActionAllowed(filePath: string, allowedRoot: string): void {
  if (isHttpArtifact(filePath)) return; // browser path, not the file gate
  const verdict = validateArtifactTarget(filePath, allowedRoot);
  if (!verdict.ok) {
    throw new Error(artifactDenialText(verdict.reason));
  }
}

/** Create a HostAdapter bound to ONE project root. Recreate it
 *  whenever the workspace root changes. `onActionError` fires for
 *  every denial and host failure so the app shell can write a
 *  Diagnostics record (§9.3 step 5). */
export function createTryloHostAdapter(
  allowedRoot: string,
  onActionError?: (message: string, filePath: string) => void,
): HostAdapter {
  const report = (err: unknown, filePath: string): never => {
    const message = err instanceof Error ? err.message : String(err);
    onActionError?.(message, filePath);
    throw err instanceof Error ? err : new Error(message);
  };

  return {
    async openFile(filePath) {
      try {
        assertFileActionAllowed(filePath, allowedRoot);
        await call<void>("work_host_open_file", { filePath, allowedRoot });
      } catch (err) {
        report(err, filePath);
      }
    },

    async openFileWithApp(filePath, app: OpenWithApp) {
      try {
        assertFileActionAllowed(filePath, allowedRoot);
        await call<void>("work_host_open_file_with_app", {
          filePath,
          appIdentifier: app.identifier,
          appName: app.name,
          allowedRoot,
        });
      } catch (err) {
        report(err, filePath);
      }
    },

    async showInFolder(filePath) {
      try {
        assertFileActionAllowed(filePath, allowedRoot);
        await call<void>("work_host_show_in_folder", { filePath, allowedRoot });
      } catch (err) {
        report(err, filePath);
      }
    },

    async copyToClipboard(text) {
      // Clipboard carries no launch risk; no gate here.
      await call<void>("work_host_copy_to_clipboard", { text });
    },
  };
}
