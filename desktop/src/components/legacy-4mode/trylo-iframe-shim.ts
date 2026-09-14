// Trylo Desktop — Legacy `vscode` global shim. See ARCHITECTURE.md
// §3 Phase 2 task #1 (iframe mount) and the Phase 2 plan §5.1
// (shim strategy).
//
// The 14,934-line legacy 4-mode webview in `webview-script/` calls
// `acquireVsCodeApi()` and uses `vscode.postMessage()`, `getState()`,
// and `setState()`. The new Trylo Desktop replaces this with
// `acquireTryloApi()`. We bridge the two by exposing
// `acquireVsCodeApi()` in the iframe context that delegates to the
// new API.
//
// The shim is meant to be loaded as the FIRST script in the iframe
// `index.html`, before the legacy webview-script files. It detects
// the parent (the React app) and pulls the `TryloApi` from it.

import type {
  TryloApi,
  TryloRequest,
  TryloResponse,
} from '../../host-adapter/trylo-api';

interface VsCodeShim {
  postMessage(msg: TryloRequest): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

/**
 * Wait for the parent to expose a `TryloApi` via `acquireTryloApi()`.
 * The parent installs the function on the iframe's `window` object
 * during the iframe's `onLoad` handler. If the function is not
 * installed within `timeoutMs`, the shim rejects so the legacy
 * webview sees a clear error rather than hanging.
 */
async function waitForTryloApi(timeoutMs = 5000): Promise<TryloApi> {
  const start = Date.now();
  // The parent calls `iframeWindow.acquireTryloApi = () => api`. The
  // function must be defined on THIS window, not on `parent`, because
  // cross-frame assignment is the parent's privilege.
  while (typeof window.acquireTryloApi !== 'function') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        'trylo-iframe-shim: parent never installed window.acquireTryloApi',
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return window.acquireTryloApi();
}

/**
 * Build the legacy `vscode` global. Maps the no-Promise single-shot
 * `vscode.postMessage` style to the new Promise-returning
 * `acquireTryloApi().postMessage`. State persistence is delegated
 * to `getState` / `setState` on the new API.
 *
 * The shim is intentionally Promise-returning on `postMessage` even
 * though the legacy code does not `await` it — VS Code's webview
 * also returns `void`, but the new model is Promise-based, so we
 * expose both shapes: the legacy field `vscode.postMessage(msg)`
 * returns `void` (fire-and-forget), and the request is sent in the
 * background. The legacy code that needs a response listens on
 * `window.addEventListener('message', ...)` for the response from
 * the parent.
 */
export function makeVsCodeShim(api: TryloApi): VsCodeShim {
  return {
    postMessage(msg: TryloRequest): void {
      // Fire-and-forget. The parent's `onMessage` event handler
      // delivers the response via `iframe.contentWindow.postMessage`.
      // The legacy code's response handler is a window 'message'
      // listener.
      void api.postMessage<TryloRequest, TryloResponse>(msg).catch((err) => {
        // The legacy code does not have a structured error path;
        // surface the error to the console so a developer can see it.
        // eslint-disable-next-line no-console
        console.error('[trylo-iframe-shim] postMessage failed', msg.type, err);
      });
    },
    getState<T>(): T | undefined {
      return api.getState<T>();
    },
    setState<T>(state: T): void {
      api.setState(state);
    },
  };
}

/**
 * Install `window.vscode` so the legacy code's
 * `acquireVsCodeApi()` returns our shim. Runs in the iframe
 * context; the parent (React app) must have already set
 * `window.acquireTryloApi` before this runs.
 */
export async function installVsCodeShim(): Promise<VsCodeShim> {
  const api = await waitForTryloApi();
  const shim = makeVsCodeShim(api);
  // The legacy code calls `acquireVsCodeApi()` at module load. We
  // shadow the global function with one that returns the shim.
  (window as unknown as { vscode?: VsCodeShim }).vscode = shim;
  // The legacy code may also check for a state restore on init.
  return shim;
}

// Expose for non-module consumers (the iframe's index.html).
declare global {
  interface Window {
    acquireTryloApi?: () => Promise<TryloApi>;
    vscode?: VsCodeShim;
  }
}
