/** Bridge to the HTML startup screen; safe in fixtures without the early screen. */
export function updateStartupScreen(message: string): void {
  window.dispatchEvent(new CustomEvent('trylo:startup-stage', { detail: message }));
}

/** Readiness releases app interaction and allows the approved visual handoff. */
export function dismissStartupScreen(): void {
  window.dispatchEvent(new Event('trylo:startup-ready'));
}

/** Recovery must appear immediately, without waiting for brand presentation. */
export function dismissStartupScreenImmediately(): void {
  window.dispatchEvent(new Event('trylo:startup-dismiss'));
}
