// Trylo Work — ArtifactCard. See README.md.
//
// Ported from CoWork-OS's 4 separate `*ArtifactCard.tsx` files
// (DocumentArtifactCard, PresentationArtifactCard,
// SpreadsheetArtifactCard, WebArtifactCard — committed 0.5.51).
// Those four were 95% identical, varying only in:
//   - format label / icon / menu entries
//   - the "open with app" submenu
//   - a small amount of "can edit" / "can preview" logic
//
// This file consolidates them into a single component with a
// `kind: "document" | "presentation" | "spreadsheet" | "web"`
// prop. The only host-specific calls (open file, show in
// folder, copy path) go through `HostAdapter`, so the card
// has no Tauri/Electron imports — see ../host-adapter/.
//
// Source line refs for the ported code:
//   DocumentArtifactCard.tsx:1-187
//   PresentationArtifactCard.tsx:1-180
//   SpreadsheetArtifactCard.tsx:1-184
//   WebArtifactCard.tsx:1-179
// All under vendor/cowork-os/src/renderer/components/.
//
// Visual re-skin: class names are Trylo-token-friendly (BEM-ish,
// pull from --bg-elevated / --accent / --border etc. — see
// styles/components/work/artifact-card.css). The cowork originals
// used their own design system; we throw it away and inherit
// from Trylo's tokens.css.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Clipboard,
  ExternalLink,
  FolderOpen,
} from "lucide-react";
import {
  canOpenArtifactInApp,
  getFileName,
  type ArtifactKind,
} from "./format-helpers";
import {
  artifactDenialText,
  isHttpArtifact,
  validateArtifactTarget,
} from "../artifact-paths.js";
import type { HostAdapter } from "../host-adapter/host-adapter";

export interface ArtifactCardProps {
  readonly filePath: string;
  readonly kind: ArtifactKind;
  readonly workspacePath?: string;
  /** Called when the user picks the primary "Open" action and the
   *  artifact kind supports an in-app preview. The host decides
   *  what "preview" means (open a viewer, open in default app,
   *  navigate to it in the IDE file tree, etc.). */
  readonly onOpenViewer?: (path: string) => void;
  /** Host bridge. Defaults to `noOpHostAdapter` so the component
   *  is usable in isolation. */
  readonly host?: HostAdapter;
  /** M3 closure §9.3: every failed host action surfaces here in
   *  addition to the in-card alert, so the app shell can write a
   *  Diagnostics record. */
  readonly onActionError?: (message: string, filePath: string) => void;
}

interface AppEntry {
  readonly name: string;
  readonly identifier: string;
  readonly iconLabel: string;
  readonly iconClass: string;
}

// Per-kind "open with" submenus. These are the apps cowork
// suggests. On a real Trylo install the host adapter may add
// more (or fewer) — this is just the default list.
const OPEN_WITH_APPS: Record<ArtifactKind, readonly AppEntry[]> = {
  document: [
    { name: "Microsoft Word", identifier: "winword",   iconLabel: "W", iconClass: "word" },
    { name: "Pages",          identifier: "pages",     iconLabel: "P", iconClass: "pages" },
    { name: "TextEdit",       identifier: "textedit",  iconLabel: "T", iconClass: "textedit" },
  ],
  presentation: [
    { name: "Microsoft PowerPoint", identifier: "powerpnt", iconLabel: "P", iconClass: "powerpoint" },
    { name: "Keynote",               identifier: "keynote",  iconLabel: "K", iconClass: "keynote" },
    { name: "LibreOffice Impress",   identifier: "soffice",  iconLabel: "L", iconClass: "libreoffice" },
    { name: "Preview",               identifier: "preview",  iconLabel: "V", iconClass: "preview" },
  ],
  spreadsheet: [
    { name: "Microsoft Excel",     identifier: "excel",   iconLabel: "X", iconClass: "excel" },
    { name: "Numbers",             identifier: "numbers", iconLabel: "N", iconClass: "numbers" },
    { name: "Microsoft Outlook",   identifier: "outlook", iconLabel: "O", iconClass: "outlook" },
  ],
  web: [], // Web cards have "Open in browser" + "Copy path" instead of "Open with"
  // P2-1 (spec §8.6): generic files get no fabricated Office "Open with"
  // submenu — the card keeps Open / Copy path / Show in folder.
  file: [],
};

const KIND_LABEL: Record<ArtifactKind, string> = {
  document:     "Document",
  presentation: "Presentation",
  spreadsheet:  "Spreadsheet",
  web:          "Web page",
  file:         "File",
};



export function ArtifactCard(props: ArtifactCardProps): JSX.Element {
  const host = props.host ?? noopHostAdapter;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const fileName = getFileName(props.filePath);
  const canOpenInViewer = canOpenArtifactInApp(props.kind, props.filePath);

  // §9.3 security gate (M3-P1-11): file actions must prove the
  // target sits inside the project root BEFORE any host call.
  // http(s) web artifacts go to the browser and skip the file
  // gate. When the gate denies the action the buttons are
  // disabled and the reason is shown — never left clickable.
  const isUrl = isHttpArtifact(props.filePath);
  const gateVerdict = isUrl
    ? { ok: true as const, canonical: props.filePath }
    : validateArtifactTarget(props.filePath, props.workspacePath);
  const denial = gateVerdict.ok ? undefined : gateVerdict.reason;
  const denialText = denial !== undefined ? artifactDenialText(denial) : undefined;

  // §9.3 step 5: host failures get a visible in-card alert plus
  // an onActionError hook (the app shell writes Diagnostics).
  const [actionError, setActionError] = useState<string | null>(null);
  const runHostAction = (action: () => Promise<void>): void => {
    setActionError(null);
    action().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      props.onActionError?.(message, props.filePath);
    });
  };

  // Close menu on outside pointer / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (actionsRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Recompute menu position when opened / on viewport changes.
  useEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    const update = () => {
      const rect = actionsRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 250;
      const padding = 12;
      const left = Math.min(
        Math.max(padding, rect.right - menuWidth),
        window.innerWidth - menuWidth - padding,
      );
      setMenuPosition({ top: rect.bottom + 8, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen]);

  const handleOpen = () => {
    setMenuOpen(false);
    if (denial !== undefined) return;
    if (canOpenInViewer && props.onOpenViewer) {
      props.onOpenViewer(props.filePath);
      return;
    }
    runHostAction(() => host.openFile(props.filePath));
  };

  const handleOpenWithApp = (app: AppEntry) => {
    setMenuOpen(false);
    if (denial !== undefined) return;
    runHostAction(() =>
      host.openFileWithApp(props.filePath, {
        name: app.name,
        identifier: app.identifier,
      }),
    );
  };

  const handleShowInFolder = () => {
    setMenuOpen(false);
    if (denial !== undefined) return;
    runHostAction(() => host.showInFolder(props.filePath));
  };

  const handleCopyPath = () => {
    setMenuOpen(false);
    runHostAction(() => host.copyToClipboard(props.filePath));
  };

  const apps = OPEN_WITH_APPS[props.kind];

  return (
    <div className={`artifact-card artifact-card--${props.kind}`}>
      <span className="artifact-card__name" title={denial !== undefined ? denialText : fileName}>
        {fileName}
      </span>
      <div className="artifact-card__actions" ref={actionsRef}>
        <button
          type="button"
          className="artifact-card__open"
          onClick={handleOpen}
          disabled={denial !== undefined}
          title={denial !== undefined ? denialText : `Open ${KIND_LABEL[props.kind].toLowerCase()}`}
        >
          <ArrowUpRight size={14} strokeWidth={2} />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="artifact-card__menu-btn"
          onClick={() => setMenuOpen((c) => !c)}
          title="Open options"
          aria-label="Open options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M3.5 5.25L7 8.75L10.5 5.25"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {menuOpen && menuPosition && createPortal(
        <div
          className="artifact-card__menu"
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", top: menuPosition.top, left: menuPosition.left, right: "auto" }}
        >
          {props.kind === "web" ? (
            <>
              <button type="button" role="menuitem" onClick={handleOpen} disabled={denial !== undefined} title={denialText}>
                <ExternalLink size={14} />
                Open in browser
              </button>
              <button type="button" role="menuitem" onClick={handleCopyPath}>
                <Clipboard size={14} />
                Copy path
              </button>
            </>
          ) : props.kind === "file" ? (
            <button type="button" role="menuitem" onClick={handleCopyPath}>
              <Clipboard size={14} />
              Copy path
            </button>
          ) : (
            apps.map((app) => (
              <button
                key={app.identifier}
                type="button"
                role="menuitem"
                onClick={() => handleOpenWithApp(app)}
                disabled={denial !== undefined}
                title={denialText}
              >
                {app.name}
              </button>
            ))
          )}
          <div className="artifact-card__menu-separator" />
          <button type="button" role="menuitem" onClick={handleShowInFolder} disabled={denial !== undefined} title={denialText}>
            <FolderOpen size={14} />
            Open in folder
          </button>
        </div>,
        document.body,
      )}
      {denialText !== undefined && (
        <div className="artifact-card__denied" role="note">{denialText}</div>
      )}
      {actionError !== null && (
        <div className="artifact-card__error" role="alert">{actionError}</div>
      )}
    </div>
  );
}

// The local default. We import noOpHostAdapter under a private
// name to keep this file's exports clean.
import { noOpHostAdapter as noopHostAdapter } from "../host-adapter/host-adapter";
