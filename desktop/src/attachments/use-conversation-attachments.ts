// Trylo Desktop — React binding for the partitioned attachment
// store (P2-1 Work Package B).
//
// Components read attachments ONLY through this hook; the store is
// the source of truth. `useSyncExternalStore` subscribes to the
// owner's partition key — the owner object itself may be a fresh
// literal every render, identity is derived from its key.

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  conversationAttachmentStore,
  ownerKey,
  type AttachmentOwner,
  type AttachmentPartitionSnapshot,
} from './conversation-attachment-store';

export interface ConversationAttachmentsActions {
  /** Acquire explicit paths (used by the drop handler). */
  readonly addByPaths: (paths: readonly string[]) => void;
  /** Open the native picker and acquire the selection. */
  readonly openPicker: () => void;
  readonly remove: (id: string) => void;
  readonly dismissFailed: (id: string) => void;
  readonly retryFailed: (id: string) => void;
}

export interface ConversationAttachmentsState extends AttachmentPartitionSnapshot {
  /** Convenience flag: readingCount > 0. */
  readonly loading: boolean;
  readonly actions: ConversationAttachmentsActions;
}

/** Subscribe to one conversation's attachment partition. `owner` may
 *  be null (no workspace / conversation) — the hook then renders the
 *  empty snapshot and every action is a no-op. */
export function useConversationAttachments(
  owner: AttachmentOwner | null,
): ConversationAttachmentsState {
  const key = owner !== null ? ownerKey(owner) : '';

  // The owner literal changes every render; keep the latest in a ref
  // so the stable callbacks below always act on the current owner.
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === '') return () => {};
      return conversationAttachmentStore.subscribeKey(key, onChange);
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => conversationAttachmentStore.snapshotKey(key),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const actions = useMemo<ConversationAttachmentsActions>(() => ({
    addByPaths: (paths) => {
      const o = ownerRef.current;
      if (o !== null) void conversationAttachmentStore.acquireByPaths(o, paths);
    },
    openPicker: () => {
      const o = ownerRef.current;
      if (o !== null) void conversationAttachmentStore.openPicker(o);
    },
    remove: (id) => {
      const o = ownerRef.current;
      if (o !== null) conversationAttachmentStore.remove(o, id);
    },
    dismissFailed: (id) => {
      const o = ownerRef.current;
      if (o !== null) conversationAttachmentStore.dismissFailed(o, id);
    },
    retryFailed: (id) => {
      const o = ownerRef.current;
      if (o !== null) conversationAttachmentStore.retryFailed(o, id);
    },
    // The callbacks read the owner from ownerRef, so the memo never
    // needs to rebuild — stable identity for children.
  }), []);

  return {
    ...snapshot,
    loading: snapshot.readingCount > 0,
    actions,
  };
}
