// Trylo Desktop — ProfileCard: the user identity popover anchored
// to the left rail's profile row. Two steps in one card:
//
//   card    avatar + nickname (both inline-editable) + menu rows
//   avatar  stage a new avatar (native picker or preset), confirm
//
// Presentational — all state and IO live in useUserProfile.
// v4 design (owner-approved, minimalist): pure white surface
// separated by a hairline; left-aligned; colour appears exactly
// once (the Confirm button); no band, no subtitle, no format hint.
// Positioned via a portal + the anchor's rect (same pattern as
// ModePopover) so the card can overflow the 210px rail without
// being clipped by its overflow:hidden.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Camera, Pencil, Settings2, Upload } from 'lucide-react';
import {
  DEFAULT_AVATAR,
  PROFILE_PRESETS,
  type ProfileAvatar,
  type ProfilePreset,
  type ResolvedProfile,
} from '../../user-profile/profile-types';
import type { AvatarDraft, ProfileStep } from '../../user-profile/use-user-profile';
import type { DesktopAccountModel } from '../../account/desktop-account';
import { ProfileAccountContent } from './ProfileAccountContent';

/** Card width. Wider than the rail on purpose: a profile card
 *  squeezed into a 210px rail reads as cramped. */
const CARD_WIDTH = 288;

/** Avatar renderer shared by the rail row and the card: the stored
 *  image when present, otherwise a tinted initials circle. The
 *  caller owns the frame (rail row, card face, stage preview) via
 *  `className`; `size` is the circle diameter in px. */
export function ProfileAvatarView(props: {
  readonly avatar: ProfileAvatar;
  readonly avatarUrl: string | null;
  readonly size: number;
  readonly className?: string;
}): ReactElement {
  const { avatar, avatarUrl, size, className } = props;
  const classes = className === undefined ? '' : ` ${className}`;
  if (avatar.kind === 'image' && avatarUrl !== null) {
    return (
      <img
        className={`profile-avatar-img${classes}`}
        src={avatarUrl}
        alt=""
        style={{ width: size, height: size }}
      />
    );
  }
  const shown = avatar.kind === 'image' ? DEFAULT_AVATAR : avatar;
  return (
    <span
      className={`profile-avatar-initial${classes}`}
      style={{
        width: size,
        height: size,
        background: shown.bg,
        color: shown.fg,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {shown.letter}
    </span>
  );
}

interface EditableTextProps {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly className: string;
  readonly onCommit: (value: string) => void;
}

/** Click-to-edit inline text. Enter or blur commits; Escape cancels.
 *  The pencil only shows on hover so the resting state stays clean. */
function EditableText(props: EditableTextProps): ReactElement {
  const { value, placeholder, label, className, onCommit } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`${className} profile-card__input`}
        value={text}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          setEditing(false);
          onCommit(text);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            setEditing(false);
            onCommit(text);
          } else if (event.key === 'Escape') {
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`${className} profile-card__edit`}
      aria-label={label}
      onClick={() => {
        setText(value);
        setEditing(true);
      }}
    >
      <span className={value.length > 0 ? undefined : 'profile-card__edit-empty'}>
        {value.length > 0 ? value : placeholder}
      </span>
      <Pencil size={12} className="profile-card__pen" />
    </button>
  );
}

export interface ProfileCardProps {
  readonly account?: DesktopAccountModel;
  readonly remoteActive?: boolean;
  /** Which step to show. The card is only mounted while open. */
  readonly step: Exclude<ProfileStep, 'closed'>;
  readonly profile: ResolvedProfile;
  readonly draft: AvatarDraft | null;
  readonly notice: string | null;
  /** True while the native picker + import is in flight. Suppresses
   *  outside-dismiss (a closing modal dialog synthesizes a stray
   *  pointerdown that would otherwise discard the staged import). */
  readonly picking: boolean;
  /** The rail's profile row — the popover anchors to its rect. */
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onCommitNickname: (value: string) => void;
  readonly onCommitBio: (value: string) => void;
  readonly onStartAvatarEdit: () => void;
  readonly onBackToCard: () => void;
  readonly onPickImage: () => void;
  readonly onPickPreset: (preset: ProfilePreset) => void;
  readonly onConfirmAvatar: () => void;
  readonly onCancelAvatar: () => void;
}

function isPresetSelected(draft: AvatarDraft | null, preset: ProfilePreset): boolean {
  if (draft === null || draft.avatar.kind !== 'initial') return false;
  const avatar = draft.avatar;
  return (
    avatar.letter === preset.letter &&
    avatar.bg === preset.bg &&
    avatar.fg === preset.fg
  );
}

export function ProfileCard(props: ProfileCardProps): ReactElement {
  const {
    step,
    profile,
    draft,
    notice,
    picking,
    anchorRef,
    onClose,
    onOpenSettings,
    onCommitNickname,
    onCommitBio,
    onStartAvatarEdit,
    onBackToCard,
    onPickImage,
    onPickPreset,
    onConfirmAvatar,
    onCancelAvatar,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const focusWithin = useRef(false);
  const focusMounted = useRef(false);
  const hasAccount = props.account !== undefined;
  // Background account refresh must not interrupt typing in local profile fields.
  const accountPhase = editingProfile || step !== 'card' ? undefined : props.account?.phase;
  useEffect(() => {
    const onFocus = (event: FocusEvent): void => { focusWithin.current = rootRef.current?.contains(event.target as Node) === true; };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  useEffect(() => {
    if (hasAccount && (!focusMounted.current || focusWithin.current)) {
      rootRef.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)')?.focus({ preventScroll: true });
      focusMounted.current = true;
    }
  }, [hasAccount, accountPhase, editingProfile, step]);

  // Position against the anchor's rect, clamped to the viewport —
  // same shape as ModePopover. The card is 288px wide and the rail
  // is 210px, so it deliberately extends over the content area.
  //
  // Field bug 2026-10-14: placing once in useLayoutEffect measured a
  // half-laid-out card (offsetHeight 205 instead of 331), so the
  // Confirm/Cancel row rendered below the viewport and was
  // unclickable — the avatar could be picked but never saved. A
  // ResizeObserver re-places whenever the card's real height lands,
  // which also covers the card → avatar-step transition.
  useLayoutEffect(() => {
    const place = (): void => {
      const card = rootRef.current;
      const anchor = anchorRef.current;
      if (card === null || anchor === null) return;
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      const above = rect.top - gap;
      const below = window.innerHeight - rect.bottom - gap;
      const height = card.offsetHeight;
      // Prefer opening upward (the anchor sits in the rail footer);
      // flip down only when the upward space is genuinely too small.
      const down = below >= height && below > above;
      const maxHeight = Math.max(96, down ? below : above);
      const clamped = Math.min(height, maxHeight);
      Object.assign(card.style, {
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(CARD_WIDTH, window.innerWidth - 16) - 8))}px`,
        top: `${down ? rect.bottom + gap : Math.max(8, rect.top - clamped - gap)}px`,
        maxHeight: `${maxHeight}px`,
      });
    };
    place();
    const card = rootRef.current;
    // ResizeObserver re-places the card once its real height lands
    // (the field bug) and on the card -> avatar-step swap. Guarded
    // because jsdom has no ResizeObserver; place() still runs once.
    const observer =
      card === null || typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            place();
          });
    if (card !== null && observer !== null) observer.observe(card);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      if (observer !== null) observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        anchorRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      }
    };
    // Clicks outside close the card — except on the rail's profile
    // row (which owns the toggle, otherwise outside-close + row
    // toggle would fight), and except while an import is in flight
    // (the closing native dialog synthesizes a stray pointerdown).
    const onPointerDown = (event: PointerEvent): void => {
      if (picking) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (anchorRef.current?.contains(target) === true) return;
      const root = rootRef.current;
      if (root !== null && !root.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [anchorRef, onClose, picking]);

  return createPortal(
    <div
      ref={rootRef}
      className={`profile-card${props.account ? ' profile-card--account' : ''}`}
      role="dialog"
      aria-label={props.account ? '账号与个人资料' : '用户资料'}
      style={{ width: CARD_WIDTH, maxWidth: 'calc(100vw - 16px)' }}
    >
      {step === 'card' && props.account && !editingProfile ? <ProfileAccountContent
        account={props.account} remoteActive={props.remoteActive} nickname={profile.nickname}
        avatar={<ProfileAvatarView avatar={profile.avatar} avatarUrl={profile.avatarUrl} size={36}/>}
        onClose={onClose} onEditProfile={() => setEditingProfile(true)}
      /> : step === 'card' ? (
        <div className="profile-card__body">
          {props.account && <div className="profile-card__step-head"><button type="button" className="profile-card__back" aria-label="返回账号" onClick={() => setEditingProfile(false)}><ArrowLeft size={14}/></button><span className="profile-card__step-title">个人资料</span></div>}
          <div className="profile-card__head">
            <button
              type="button"
              className="profile-card__avatar-btn"
              onClick={onStartAvatarEdit}
              aria-label="当前头像，点击更换"
            >
              <ProfileAvatarView
                avatar={profile.avatar}
                avatarUrl={profile.avatarUrl}
                size={44}
              />
              <span className="profile-card__avatar-badge" aria-hidden="true">
                <Camera size={11} strokeWidth={2.2} />
              </span>
            </button>
            <div className="profile-card__head-text">
              <EditableText
                className="profile-card__name"
                value={profile.nickname}
                placeholder="本地用户"
                label="昵称"
                onCommit={onCommitNickname}
              />
            </div>
          </div>
          <div className="profile-card__bio-row">
            <EditableText
              className="profile-card__bio"
              value={profile.bio}
              placeholder="写一句介绍自己"
              label="简介"
              onCommit={onCommitBio}
            />
          </div>
          {notice !== null && <p className="profile-card__notice">{notice}</p>}
          <div className="profile-card__divider" />
          <button type="button" className="profile-card__menu-row" onClick={onStartAvatarEdit}>
            <Camera size={15} />
            更换头像
          </button>
          <button type="button" className="profile-card__menu-row" onClick={onOpenSettings}>
            <Settings2 size={15} />
            设置与连接
          </button>
        </div>
      ) : (
        <div className="profile-card__body">
          <div className="profile-card__step-head">
            <button
              type="button"
              className="profile-card__back"
              onClick={onBackToCard}
              aria-label="返回资料卡"
            >
              <ArrowLeft size={14} />
            </button>
            <span className="profile-card__step-title">更换头像</span>
          </div>
          <div className="profile-card__stage">
            <span className="profile-card__stage-face">
              <ProfileAvatarView
                avatar={draft?.avatar ?? profile.avatar}
                avatarUrl={draft === null ? profile.avatarUrl : draft.avatarUrl}
                size={72}
              />
            </span>
            <button
              type="button"
              className="profile-card__ghost"
              onClick={onPickImage}
              disabled={picking}
            >
              <Upload size={15} />
              {picking ? '正在读取图片…' : '从本机选图'}
            </button>
          </div>
          <div className="profile-card__presets-label">或选一个预设</div>
          <div className="profile-card__presets">
            {PROFILE_PRESETS.map((preset) => (
              <button
                key={preset.letter}
                type="button"
                className={`profile-card__preset${
                  isPresetSelected(draft, preset) ? ' profile-card__preset--on' : ''
                }`}
                style={{ background: preset.bg, color: preset.fg }}
                aria-label={`预设头像 ${preset.letter}`}
                aria-pressed={isPresetSelected(draft, preset)}
                onClick={() => onPickPreset(preset)}
              >
                {preset.letter}
              </button>
            ))}
          </div>
          {notice !== null && <p className="profile-card__notice">{notice}</p>}
          <div className="profile-card__actions">
            <button type="button" className="profile-card__ghost" onClick={onCancelAvatar}>
              取消
            </button>
            <button type="button" className="profile-card__primary" onClick={onConfirmAvatar}>
              确定
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
