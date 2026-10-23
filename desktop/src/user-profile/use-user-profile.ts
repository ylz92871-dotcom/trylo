// Trylo Desktop — useUserProfile: the profile card's state machine.
// Owns the open/closed + card/avatar steps, the staged avatar
// draft, and the save path. All IO goes through the injected
// ProfileStore (the Tauri-backed singleton by default), so this
// hook is testable with a fake store and the component stays
// presentational.

import { useCallback, useEffect, useRef, useState } from 'react';
import { userProfileStore, type ProfileStore } from './profile-store';
import {
  DEFAULT_NICKNAME,
  defaultProfile,
  type ProfileAvatar,
  type ProfilePreset,
  type ResolvedProfile,
  type UserProfile,
} from './profile-types';

export type ProfileStep = 'closed' | 'card' | 'avatar';

/** Staged (uncommitted) avatar selection in the avatar step. */
export interface AvatarDraft {
  readonly avatar: ProfileAvatar;
  readonly avatarUrl: string | null;
}

export interface UserProfileController {
  readonly step: ProfileStep;
  readonly profile: ResolvedProfile;
  readonly draft: AvatarDraft | null;
  /** Last failure message (save / import), or null. */
  readonly notice: string | null;
  /** True while the native picker + image import is in flight.
   *  The card must not dismiss during this window: closing a
   *  modal file dialog makes WebView2 synthesize a stray
   *  pointerdown on the page, which used to close the card and
   *  silently discard the staged import (real bug, 2026-10-14:
   *  avatar.png landed on disk, profile.json never written). */
  readonly picking: boolean;
  readonly toggle: () => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly commitNickname: (nickname: string) => void;
  readonly commitBio: (bio: string) => void;
  readonly startAvatarEdit: () => void;
  readonly backToCard: () => void;
  readonly pickPreset: (preset: ProfilePreset) => void;
  readonly pickImage: () => Promise<void>;
  readonly confirmAvatar: () => void;
  readonly cancelAvatar: () => void;
}

export function useUserProfile(store: ProfileStore = userProfileStore): UserProfileController {
  const [profile, setProfile] = useState<ResolvedProfile>(() => ({
    ...defaultProfile(),
    avatarUrl: null,
  }));
  const [step, setStep] = useState<ProfileStep>('closed');
  const [draft, setDraft] = useState<AvatarDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Latest values for callbacks that must not close over stale state.
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let alive = true;
    void store
      .load()
      .then((loaded) => {
        if (alive) setProfile(loaded);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [store]);

  const persist = useCallback(
    async (next: UserProfile): Promise<void> => {
      try {
        const saved = await store.save(next);
        setProfile(saved);
        setNotice(null);
      } catch {
        setNotice('资料保存失败，请稍后再试');
      }
    },
    [store],
  );

  const toggle = useCallback(() => {
    setStep((current) => {
      if (current !== 'closed') return 'closed';
      // A staged avatar that survived a mid-pick dismissal resumes
      // where the user left off instead of silently vanishing.
      return draftRef.current !== null ? 'avatar' : 'card';
    });
  }, []);
  const open = useCallback(() => { setStep(current => current === 'closed' ? (draftRef.current ? 'avatar' : 'card') : current); }, []);

  // Closing keeps the draft: an import lost to a stray pointer
  // event must not throw away the user's photo.
  const close = useCallback(() => {
    setStep('closed');
  }, []);

  const commitNickname = useCallback(
    (nickname: string) => {
      const trimmed = nickname.trim();
      void persist({
        ...profileRef.current,
        nickname: trimmed.length > 0 ? trimmed : DEFAULT_NICKNAME,
      });
    },
    [persist],
  );

  const commitBio = useCallback(
    (bio: string) => {
      void persist({ ...profileRef.current, bio: bio.trim() });
    },
    [persist],
  );

  const startAvatarEdit = useCallback(() => {
    setDraft({ avatar: profileRef.current.avatar, avatarUrl: profileRef.current.avatarUrl });
    setNotice(null);
    setStep('avatar');
  }, []);

  const backToCard = useCallback(() => {
    setDraft(null);
    setStep('card');
  }, []);

  const pickPreset = useCallback((preset: ProfilePreset) => {
    setDraft({
      avatar: { kind: 'initial', letter: preset.letter, bg: preset.bg, fg: preset.fg },
      avatarUrl: null,
    });
  }, []);

  const pickImage = useCallback(async () => {
    setNotice(null);
    setPicking(true);
    try {
      const source = await store.pickImage();
      if (source === null) return;
      const imported = await store.importAvatar(source);
      setDraft({ avatar: imported.avatar, avatarUrl: imported.avatarUrl });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '头像导入失败');
    } finally {
      setPicking(false);
    }
  }, [store]);

  const confirmAvatar = useCallback(() => {
    const staged = draft;
    setDraft(null);
    setStep('card');
    if (staged !== null) {
      void persist({ ...profileRef.current, avatar: staged.avatar });
    }
  }, [draft, persist]);

  const cancelAvatar = useCallback(() => {
    setDraft(null);
    setStep('card');
  }, []);

  return {
    step,
    profile,
    draft,
    notice,
    picking,
    toggle,
    open,
    close,
    commitNickname,
    commitBio,
    startAvatarEdit,
    backToCard,
    pickPreset,
    pickImage,
    confirmAvatar,
    cancelAvatar,
  };
}
