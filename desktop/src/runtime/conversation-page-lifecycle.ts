export interface ConversationPageLifecycleInput {
  readonly host: 'native' | 'browser';
  readonly page: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly stopAll: () => Promise<void>;
  readonly onStopError: (error: unknown) => void;
}

/** A native host owns shutdown across WebView reloads; browser pages own theirs. */
export function bindConversationPageLifecycle(input: ConversationPageLifecycleInput): () => void {
  if (input.host === 'native') return () => {};
  const onPageHide = (): void => {
    try { void input.stopAll().catch(input.onStopError); }
    catch (error) { input.onStopError(error); }
  };
  input.page.addEventListener('pagehide', onPageHide);
  return () => input.page.removeEventListener('pagehide', onPageHide);
}
