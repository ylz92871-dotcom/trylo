// Trylo Desktop — SettingsPanel. See the architecture doc §3
// Phase 1 #8 (Settings UI).
//
// Form-based panel for editing AppSettings. Edits flow through
// useSettings.update which writes through to the SettingsService
// (which writes the JSON file via Tauri).
//
// Spike scope: 4 fields (theme, fontSize, tabSize, showLineNumbers).
// Word wrap is part of the AppSettings type but not surfaced in
// the UI yet — Phase 1 polish.

import { type ReactElement } from 'react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Theme,
} from '../../host-adapter';
import { useSettings } from './useSettings';
import type { FilePath, SettingsService } from '../../host-adapter';
import './SettingsPanel.css';

export interface SettingsPanelProps {
  readonly workspaceRoot: FilePath;
  readonly service: SettingsService;
  /**
   * Optional callback fired whenever the user changes the
   * theme. App.tsx wires this to its `useTheme.setTheme` so
   * the change applies instantly (the .trylo/settings.json
   * write happens via `update` separately). Keeping the theme
   * here means SettingsPanel doesn't need to know about
   * useTheme directly.
   */
  readonly onThemeChange: (next: Theme) => void;
}

export function SettingsPanel({
  workspaceRoot,
  service,
  onThemeChange,
}: SettingsPanelProps): ReactElement {
  const { settings, update, loading } = useSettings(workspaceRoot, service);

  return (
    <section className="settings-panel" aria-label="Workspace settings">
      <header className="settings-header">
        <span className="settings-title">Settings</span>
        <span className="settings-path">{workspaceRoot}/.trylo/settings.json</span>
        {loading && <span className="settings-loading">loading…</span>}
      </header>
      {settings.theme !== undefined && (
        <SettingsForm settings={settings} update={update} onThemeChange={onThemeChange} />
      )}
    </section>
  );
}

interface SettingsFormProps {
  readonly settings: AppSettings;
  readonly update: (patch: Partial<AppSettings>) => Promise<void>;
  readonly onThemeChange: (next: Theme) => void;
}

function SettingsForm({ settings, update, onThemeChange }: SettingsFormProps): ReactElement {
  return (
    <form
      className="settings-form"
      onSubmit={(e) => e.preventDefault()}
    >
      <label className="settings-row">
        <span>Theme</span>
        <select
          value={settings.theme}
          onChange={(e) => {
            const v = e.target.value as Theme;
            onThemeChange?.(v);
            void update({ theme: v });
          }}
        >
          <option value="auto">auto</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label className="settings-row">
        <span>Font size</span>
        <input
          type="number"
          min={8}
          max={48}
          value={settings.fontSize}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) void update({ fontSize: v });
          }}
        />
      </label>
      <label className="settings-row">
        <span>Tab size</span>
        <input
          type="number"
          min={1}
          max={16}
          value={settings.tabSize}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) void update({ tabSize: v });
          }}
        />
      </label>
      <label className="settings-row">
        <span>Show line numbers</span>
        <input
          type="checkbox"
          checked={settings.showLineNumbers}
          onChange={(e) => void update({ showLineNumbers: e.target.checked })}
        />
      </label>
      <button
        type="button"
        className="settings-reset"
        onClick={() => void update(DEFAULT_SETTINGS)}
      >
        Reset to defaults
      </button>
    </form>
  );
}
