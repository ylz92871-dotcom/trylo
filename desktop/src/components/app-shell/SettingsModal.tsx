import { AppearanceSettings } from './AppearanceSettings';
// Trylo Desktop — Settings modal. See v1.15-handoff §1.2.
//
// v1.15.2: full port of the legacy `tryloCode` config shape.
// Five groups: Provider, Auth, Behavior, Vision, Summary,
// Runtime. Sub-connections (vision / summary) collapse to
// "use primary" by default — flipping the switch reveals
// the per-group fields (mirrors extension.js's
// visionUsePrimaryConnection / summaryUsePrimaryConnection).
//
// No validation beyond what's in settings-store.ts. No
// test-connection beyond the per-host TCP probe. Phase 3
// features (encrypted secret store, full HTTP test,
// "auto-detect best model") belong in Phase 3.

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  applyProfile,
  connectionFields,
  createProfileId,
  removeProfile,
  saveSettings,
  settingsForSave,
  settingsDefaults,
  upsertProfile,
  type ApiFormat,
  type ModelProfile,
  type PermissionMode,
  type SubConnection,
  type TryloSettings,
  type SettingsSaveIntent,
} from '../../settings/settings-store';
import { PERMISSION_LEVELS, type PermissionLevel } from '../../permission/permission-policy';
import type { CliRuntimeProtocol } from '../../runtime/cli-runtime-protocol';
import { testConnection, type TestConnectionResult } from '../../host-adapter/test-connection';
import type {
  PetStatusSnapshot,
  RemoteStatusResult,
} from '../../services-host/methods';
import { petStatusDetail, petStatusHeadline, petStatusTone } from '../../companion/pet-status-text';
import { WorkToolsSettings } from './WorkToolsSettings';
import { SkillsModal } from './SkillsModal';
import type { LearningPort } from '../../learning/learning-port';
import {
  derivePackageView,
  type ToolPlatformState,
} from '../../tooling/use-tool-platform-state';

export type SettingsTab = 'connection' | 'appearance' | 'behavior' | 'tools' | 'remote' | 'subconnections' | 'learning' | 'runtime';

export interface RelayAccountActions {
  relayLogin(params: import('../../services-host/methods').RelayLoginParams): Promise<import('../../services-host/methods').RelayAccountStatus>;
  relayStatus(): Promise<import('../../services-host/methods').RelayAccountStatus>;
  relayLogout(): Promise<import('../../services-host/methods').RelayAccountStatus>;
}

export interface SettingsModalProps {
  readonly initialTab?: SettingsTab;
  readonly open: boolean;
  readonly initial: TryloSettings;
  readonly onClose: () => void;
  readonly onSave?: (settings: TryloSettings, intent: SettingsSaveIntent) => void;
  /** Real pet state from the sidecar (audit §4.2 PET-P0-1). Optional so the
   *  modal stays usable outside the wired app; absent means "unknown". */
  readonly petStatus?: PetStatusSnapshot;
  /** Real remote-gateway state (spec §8.1.4). Optional; absent means the
   *  remote domain is not wired into this host. */
  readonly remoteStatus?: RemoteStatusResult | null;
  readonly relayAccount?: RelayAccountActions | null;
  readonly onOpenRemote?: () => void;
  /** P0-A (audit §3.3): the Work tool packages' health + install actions.
   *  Optional so the modal renders in tests without the Service Host. */
  readonly toolPlatform?: ToolPlatformState | null;
  /** Hermes learning port — powers the Skills library modal (installed
   *  skills list + SKILL.md viewer). Optional so settings still renders
   *  before the Service Host is up. */
  readonly learningPort?: LearningPort | null;
  /** Opens the Learning panel on the pending-approval tab (used by the
   *  Skills modal's "go to proposals" action). */
  readonly onOpenLearningPending?: () => void;
}

type FormState = TryloSettings;

function toFormState(s: TryloSettings): FormState {
  return {
    ...s,
    vision: { ...s.vision },
    summary: { ...s.summary },
    companion: { ...s.companion },
    remote: { ...s.remote },
    userLearning: {
      ...settingsDefaults.userLearning,
      ...s.userLearning,
      dimensionMode: { ...settingsDefaults.userLearning.dimensionMode, ...s.userLearning?.dimensionMode },
    },
  };
}

const API_FORMATS: readonly { readonly value: ApiFormat; readonly label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai',     label: 'OpenAI-compatible' },
];

// P2 (spec §3.2 / §4.4): the legacy `chat | plan | agent` list is
// kept ONLY for the value migration at load time. The Settings UI
// no longer offers it as a control; the new four-level picker is
// the single source of truth.
const PERMISSION_MODES: readonly { readonly value: PermissionMode; readonly label: string; readonly hint: string }[] = [
  { value: 'chat',  label: 'Chat',  hint: 'Standard mode, asks for tool permissions' },
  { value: 'plan',  label: 'Plan',  hint: 'Read-only — design before building' },
  { value: 'agent', label: 'Agent', hint: 'Full tool access, no prompts' },
];
void PERMISSION_MODES; // legacy list kept for back-compat; see permission-policy.legacyPermissionMigration.

/** The pet is a WPF (net9.0-windows) sidecar — Windows only (spec §6.5). */
const IS_WINDOWS: boolean =
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);

/** P0-A §3.3-4: a capability switch without its package is a lie. This hint
 *  shows the required package's REAL state inline and offers the install
 *  action directly, so enabling 电脑控制/浏览器调试 surfaces what is missing
 *  instead of silently degrading (audit acceptance A03/A04). */
function WorkCapabilityHint(props: { platform: ToolPlatformState; packageId: string }): ReactElement | null {
  const { platform, packageId } = props;
  const pkg = platform.byId[packageId];
  if (!pkg) return null;
  const view = derivePackageView(pkg, platform.actions[packageId]);
  if (view.uiState === 'available') {
    return (
      <span className="settings-modal__hint">
        ✓ {pkg.displayName} {pkg.version} 已就绪。
      </span>
    );
  }
  return (
    <div className="work-tools__row work-tools__row--err">
      <div className="work-tools__row-head">
        <span className="work-tools__state work-tools__state--err">{view.message}</span>
        {view.action === 'install' || view.action === 'retry' || view.action === 'install-browser' ? (
          <button
            type="button"
            className="work-tools__action"
            onClick={() => {
              if (view.action === 'install-browser') void platform.installBrowser(packageId);
              else void platform.install(packageId);
            }}
          >
            {view.action === 'install-browser' ? '安装浏览器' : view.action === 'retry' ? '重试' : '安装'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsModal(props: SettingsModalProps): ReactElement | null {
  const [form, setForm] = useState<FormState>(() => toFormState(props.initial));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  // Sidebar tab state
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const TABS: readonly { id: SettingsTab; label: string }[] = [
    { id: 'connection', label: '模型连接' },
    { id: 'appearance', label: '外观' },
    { id: 'behavior', label: '行为与运行' },
    { id: 'tools', label: '工具与控制' },
    { id: 'remote', label: '远程' },
    { id: 'learning', label: '学习' },
  ] as const;
  // Remote pairing QR moved to the TopBar "远程" button
  // (RemotePairingModal) — 2026-08-29. Settings keeps only
  // the gateway *configuration* (port / tunnel / URL).

  useEffect(() => {
    if (props.open) {
      setSettingsTab(props.initialTab ?? 'connection');
      setForm(toFormState(props.initial));
      setTestResult(null);
      setTestError(null);
      setSaveError(null);
      setProfileName('');
    }
  }, [props.open, props.initial, props.initialTab]);

  if (!props.open) return null;

  const set = <K extends keyof TryloSettings>(k: K, v: TryloSettings[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  const setSub = (
    which: 'vision' | 'summary',
    k: keyof SubConnection,
    v: SubConnection[typeof k],
  ): void => {
    setForm((f) => ({
      ...f,
      [which]: { ...f[which], [k]: v },
    }));
  };

  const onTest = async (): Promise<void> => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await testConnection({
        apiHost: form.apiHost || 'https://api.anthropic.com',
        apiKey: form.apiKey,
        apiFormat: form.apiFormat,
      });
      setTestResult(r);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const onSave = (e: FormEvent): void => {
    e.preventDefault();
    const intent: SettingsSaveIntent = settingsTab === 'connection' ? 'connection' : 'preferences';
    const next = settingsForSave(props.initial, intent === 'connection' ? { ...form, poolModel: '' } : form);
    try { saveSettings(next); }
    catch (error) {
      setSaveError(error instanceof Error ? error.message : '设置保存失败，请重试。');
      return;
    }
    props.onSave?.(next, intent);
    props.onClose();
  };

  // ── Saved connection profiles (我的配置) ────────────────
  // Works on the modal's local FormState: 载入 loads a profile into the
  // current connection fields, 覆盖 overwrites it with the current fields,
  // 删除 removes it. All are committed when the modal is saved.
  const profileFromCurrent = (name: string): ModelProfile => ({
    id: createProfileId(),
    name,
    ...connectionFields(form),
  });

  const handleAddProfile = (): void => {
    const name = profileName.trim();
    if (!name) return;
    setForm((f) => ({ ...f, modelProfiles: [...f.modelProfiles, profileFromCurrent(name)] }));
    setProfileName('');
  };

  const handleApplyProfile = (id: string): void => {
    const p = form.modelProfiles.find((x) => x.id === id);
    if (p) setForm((f) => applyProfile(f, p));
  };

  const handleOverwriteProfile = (id: string): void => {
    setForm((f) => {
      const p = f.modelProfiles.find((x) => x.id === id);
      if (!p) return f;
      return upsertProfile(f, { ...p, ...connectionFields(f) });
    });
  };

  const handleRemoveProfile = (id: string): void => {
    setForm((f) => removeProfile(f, id));
  };

  const handleRenameProfile = (id: string, name: string): void => {
    setForm((f) => ({
      ...f,
      modelProfiles: f.modelProfiles.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  };

  // Render a sub-connection field set. Mirrors the Auth +
  // Provider section shape but uses setSub instead of set.
  const renderSubConnection = (
    which: 'vision' | 'summary',
    title: string,
    description: string,
  ): ReactElement => {
    const sub = form[which];
    return (
      <fieldset className="settings-modal__group">
        <legend className="settings-modal__legend">{title}</legend>
        <p className="settings-modal__desc">{description}</p>

        <label className="settings-modal__field settings-modal__field--inline">
          <input
            type="checkbox"
            checked={sub.usePrimaryConnection}
            onChange={(e) => setSub(which, 'usePrimaryConnection', e.target.checked)}
          />
          <span className="settings-modal__label">Use primary connection</span>
        </label>

        {!sub.usePrimaryConnection && (
          <>
            <label className="settings-modal__field">
              <span className="settings-modal__label">Model</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.model}
                onChange={(e) => setSub(which, 'model', e.target.value)}
                placeholder="claude-3-5-sonnet-latest (or leave blank for default)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Endpoint</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.endpoint}
                onChange={(e) => setSub(which, 'endpoint', e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKey}
                onChange={(e) => setSub(which, 'apiKey', e.target.value)}
                placeholder="(separate key for this connection)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Format</span>
              <select
                className="settings-modal__input"
                value={sub.apiFormat}
                onChange={(e) => setSub(which, 'apiFormat', e.target.value as ApiFormat)}
              >
                {API_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Provider preset</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.providerId}
                onChange={(e) => setSub(which, 'providerId', e.target.value)}
                placeholder="(optional)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Auth header</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKeyHeader}
                onChange={(e) => setSub(which, 'apiKeyHeader', e.target.value)}
                placeholder="Authorization"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Auth prefix</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKeyPrefix}
                onChange={(e) => setSub(which, 'apiKeyPrefix', e.target.value)}
                placeholder="Bearer "
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Extra headers (JSON)</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.extraHeadersText}
                onChange={(e) => setSub(which, 'extraHeadersText', e.target.value)}
                placeholder='{"X-Custom":"value"}'
              />
            </label>
          </>
        )}
      </fieldset>
    );
  };

  // ── Render content by selected tab ─────────────────────
  const renderSection = (tab: SettingsTab): ReactElement => {
    switch (tab) {
      case 'appearance': return <AppearanceSettings />;
      case 'connection':
        return (
          <>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">Provider</legend>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Format</span>
                <select
                  className="settings-modal__input"
                  value={form.apiFormat}
                  onChange={(e) => set('apiFormat', e.target.value as ApiFormat)}
                >
                  {API_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <span className="settings-modal__hint">
                  Anthropic for native; OpenAI-compatible for 3P providers
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Provider preset</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.providerId}
                  onChange={(e) => set('providerId', e.target.value)}
                  placeholder="(optional, e.g. anthropic, openai, ollama)"
                />
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">API host</span>
                <div className="settings-modal__row">
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="settings-modal__input"
                    value={form.apiHost}
                    onChange={(e) => set('apiHost', e.target.value)}
                    placeholder="https://api.anthropic.com"
                  />
                  <button
                    type="button"
                    className="settings-modal__btn settings-modal__btn--ghost settings-modal__test"
                    onClick={onTest}
                    disabled={testing}
                  >
                    {testing ? 'Testing…' : 'Test'}
                  </button>
                </div>
                <span className="settings-modal__hint">
                  ANTHROPIC_BASE_URL · leave blank for default
                </span>
                {testResult && (
                  <span
                    className={`settings-modal__test-result ${
                      testResult.ok ? 'settings-modal__test-result--ok' : 'settings-modal__test-result--err'
                    }`}
                  >
                    {testResult.ok ? '✓' : '✗'} {testResult.message} ({testResult.keyStatus})
                  </span>
                )}
                {testError && (
                  <span className="settings-modal__test-result settings-modal__test-result--err">
                    ✗ {testError}
                  </span>
                )}
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Model</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.apiModel}
                  onChange={(e) => set('apiModel', e.target.value)}
                  placeholder="claude-3-5-sonnet-latest"
                />
                <span className="settings-modal__hint">
                  ANTHROPIC_MODEL · leave blank for default
                </span>
              </label>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">Auth</legend>

              <label className="settings-modal__field">
                <span className="settings-modal__label">API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder="sk-ant-…"
                />
                <span className="settings-modal__hint">
                  ANTHROPIC_API_KEY · Phase 3 will move this to an encrypted store
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Auth header</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.apiKeyHeader}
                  onChange={(e) => set('apiKeyHeader', e.target.value)}
                  placeholder="Authorization"
                />
                <span className="settings-modal__hint">
                  Custom header name · only for non-Anthropic providers
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Auth prefix</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.apiKeyPrefix}
                  onChange={(e) => set('apiKeyPrefix', e.target.value)}
                  placeholder="Bearer "
                />
                <span className="settings-modal__hint">
                  Prepended to the API key in the auth header
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Extra headers (JSON)</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={form.extraHeadersText}
                  onChange={(e) => set('extraHeadersText', e.target.value)}
                  placeholder='{"X-Custom":"value"}'
                />
                <span className="settings-modal__hint">
                  Optional · raw JSON object
                </span>
              </label>
            </fieldset>

            {/* ── Saved connection profiles (我的配置) ─────────── */}
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">我的配置</legend>
              <div className="settings-modal__profiles-add">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddProfile();
                    }
                  }}
                  placeholder="配置名，如 Grok、Ollama、我的 Cluade…"
                />
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--ghost"
                  onClick={handleAddProfile}
                  disabled={!profileName.trim()}
                >
                  保存当前为新配置
                </button>
              </div>
              {form.modelProfiles.length === 0 ? (
                <span className="settings-modal__hint">
                  还没保存过配置。填好上面 Provider / Auth 后，起个名字点“保存当前为新配置”。
                </span>
              ) : (
                <ul className="settings-modal__profiles-list">
                  {form.modelProfiles.map((p) => {
                    const isActive = p.id === form.activeModelProfileId;
                    return (
                      <li key={p.id} className="settings-modal__profile">
                        <input
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          className="settings-modal__input settings-modal__profile-name"
                          value={p.name}
                          onChange={(e) => handleRenameProfile(p.id, e.target.value)}
                          aria-label="配置名"
                        />
                        <span className="settings-modal__profile-hint">
                          {p.apiModel || '默认模型'}
                          {p.apiHost ? ` · ${p.apiHost}` : ''}
                          {isActive ? ' · 当前生效' : ''}
                        </span>
                        <span className="settings-modal__profile-actions">
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--ghost"
                            onClick={() => handleApplyProfile(p.id)}
                            title="把该配置载入为当前连接"
                          >
                            载入
                          </button>
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--ghost"
                            onClick={() => handleOverwriteProfile(p.id)}
                            title="用当前表单的连接覆盖该配置"
                          >
                            覆盖
                          </button>
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--danger"
                            onClick={() => handleRemoveProfile(p.id)}
                            title="删除该配置"
                          >
                            删除
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <span className="settings-modal__hint">
                在输入框下方的模型按钮里也能一键切换这些配置
              </span>
            </fieldset>
          </>
        );

      case 'behavior':
        return (
          <>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">Behavior</legend>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Permission level</span>
                <select
                  className="settings-modal__input"
                  value={form.permissionLevel}
                  onChange={(e) => set('permissionLevel', e.target.value as PermissionLevel)}
                >
                  {PERMISSION_LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label} — {l.hint}
                    </option>
                  ))}
                </select>
                <span className="settings-modal__hint">
                  应用于 Code 与 Work 双方；会话可在 composer 临时覆盖。
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">CLI runtime</span>
                <select
                  className="settings-modal__input"
                  value={form.cliRuntimeProtocol}
                  aria-label="CLI runtime"
                  onChange={(e) =>
                    setForm((previous) => ({ ...previous,
                      cliRuntimeProtocol: e.target.value as CliRuntimeProtocol,
                      cliRuntimeSelection: 'user',
                      cliPath: e.target.value === 'trylo-v1' ? '' : settingsDefaults.cliPath,
                    }))
                  }
                >
                  <option value="legacy-stream-json">旧 CLI — legacy-stream-json</option>
                    <option value="trylo-v1">新 CLI — trylo-v1</option>
                </select>
                <span className="settings-modal__hint">
                  保存后用于下一次启动任务；已有运行中的任务沿用原 CLI。
                  切换时会同步选择对应入口，自定义路径可在下方 CLI path 中调整。录制后可在这里切回新 CLI 调试。
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">System prompt</span>
                <textarea
                  className="settings-modal__input settings-modal__textarea"
                  value={form.systemPrompt}
                  onChange={(e) => set('systemPrompt', e.target.value)}
                  placeholder="(appended to the default CLI system prompt)"
                  rows={3}
                />
                <span className="settings-modal__hint">
                  Passed as --append-system-prompt
                </span>
              </label>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">Desktop pet</legend>

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.companion.enabled}
                  onChange={(e) => set('companion', { ...form.companion, enabled: e.target.checked })}
                />
                <span className="settings-modal__label">Enable the desktop pet</span>
              </label>
              <span className="settings-modal__hint">
                {IS_WINDOWS
                  ? 'The pet shows agent state, approval requests and opens the desktop chat.'
                  : '不支持此平台 — the desktop pet is Windows-only.'}
              </span>

              {IS_WINDOWS && props.petStatus ? (
                <div
                  className={`settings-modal__pet-status settings-modal__pet-status--${petStatusTone(props.petStatus)}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="settings-modal__pet-status-headline">
                    {petStatusHeadline(props.petStatus)}
                  </span>
                  {petStatusDetail(props.petStatus) ? (
                    <span className="settings-modal__hint">{petStatusDetail(props.petStatus)}</span>
                  ) : null}
                  {props.petStatus.exePath ? (
                    <span className="settings-modal__hint">
                      Pet binary: <code>{props.petStatus.exePath}</code>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          </>
        );

      case 'tools':
        return (
          <>
            {props.toolPlatform ? <WorkToolsSettings platform={props.toolPlatform} /> : null}

            {/* ── 电脑控制 (Windows Computer Use, PR-6 spec §6.6) ─── */}
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">电脑控制 (Computer Use)</legend>

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.workComputer}
                  onChange={(e) => set('workComputer', e.target.checked)}
                />
                <span className="settings-modal__label">在 Work 中启用电脑控制（Windows 桌面工具）</span>
              </label>
              <span className="settings-modal__hint">
                {IS_WINDOWS
                  ? '开启（默认）时 Work 可读取屏幕（首次需您同意）、点击、键入与启动应用；高影响操作逐次审批，密码/支付/管理员窗口强制确认。关闭后 Work 完全不挂载桌面工具，模型看不到也使用不了。'
                  : '不支持此平台 — 电脑控制是 Windows-only 能力。'}
              </span>

              {/* P0-A §3.3-4: flipping the switch only selects a Profile — the
                  REQUIRED package must exist. Surface its real state (install
                  action when missing) so the capability is not silently
                  pretending to be there. */}
              {form.workComputer && props.toolPlatform ? (
                <WorkCapabilityHint platform={props.toolPlatform} packageId="windows-mcp" />
              ) : null}
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">Work 工具面 (Tool Profiles)</legend>

              <span className="settings-modal__hint">
                办公基底默认挂载办公文档、浏览器与桌面控制（截屏/点击等高影响操作仍逐次审批）。下面两个开关切换专用面。
              </span>

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.workBrowserDebug}
                  onChange={(e) => set('workBrowserDebug', e.target.checked)}
                />
                <span className="settings-modal__label">在 Work 中启用浏览器调试（Chrome DevTools）</span>
              </label>
              <span className="settings-modal__hint">
                {IS_WINDOWS
                  ? '关闭（默认）时 Work 使用 Playwright。开启后改用 Chrome DevTools 调试面（替换 Playwright，两者不同时启用）；首次导航新域需审批，页内脚本执行始终审批，性能数据不出本地。与 CAD 同时开启时以 CAD 为准。'
                  : '不支持此平台 — 浏览器调试是 Windows-only 能力。'}
              </span>

              {form.workBrowserDebug && props.toolPlatform ? (
                <WorkCapabilityHint platform={props.toolPlatform} packageId="chrome-devtools" />
              ) : null}

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.workCad}
                  onChange={(e) => set('workCad', e.target.checked)}
                />
                <span className="settings-modal__label">在 Work 中启用 CAD/EDA 工具（SolidWorks / AutoCAD / KiCad / 嘉立创EDA / FreeCAD / Blender）</span>
              </label>
              <span className="settings-modal__hint">
                {IS_WINDOWS
                  ? '关闭（默认）时模型看不到 CAD/EDA 工具。开启后按实际安装的软件自动启用对应适配器：查询与导出自动放行；删除/覆盖/任意代码执行逐次审批；外部资源下载需审批。未安装的软件显示为不可用能力，不影响其他工具。开启时优先于「浏览器调试」生效（CAD 面已内置桌面控制与办公工具，目检验收与报告不受影响）。'
                  : '不支持此平台 — CAD/EDA 适配器是 Windows-only 能力。'}
              </span>

              {form.workCad && !form.workBrowserDebug && props.toolPlatform ? (
                <>
                  {(
                    [
                      ['solidworks-mcp', 'SolidWorks'],
                      ['autocad-mcp', 'AutoCAD'],
                      ['kicad-mcp', 'KiCad'],
                      ['jlceda-mcp', '嘉立创EDA专业版'],
                      ['freecad-mcp', 'FreeCAD'],
                      ['blender-mcp', 'Blender'],
                    ] as const
                  ).map(([packageId]) => (
                    <WorkCapabilityHint key={packageId} platform={props.toolPlatform!} packageId={packageId} />
                  ))}
                </>
              ) : null}
            </fieldset>
          </>
        );

      case 'remote':
        return <fieldset className="settings-modal__group"><legend>远程与连接</legend><p>账号登录、服务器与独立隧道切换、手机配对已集中到同一个窗口。</p><button type="button" className="settings-modal__button" onClick={() => props.onOpenRemote?.()}>打开远程与连接</button></fieldset>;

      case 'subconnections':
        return (
          <>
            {renderSubConnection(
              'vision',
              'Vision (image input)',
              'Used when the agent reads images. Defaults to the primary connection — flip the switch to give it a separate endpoint, key, or model.',
            )}
            {renderSubConnection(
              'summary',
              'Summary (compaction)',
              'Used by the compactor. Same default-to-primary behavior. The legacy extension defaults to "shared primary".',
            )}
          </>
        );

      case 'learning':
        return (
          <>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">User Learning</legend>
              <p className="settings-modal__desc">
                协作偏好学习：Evidence → Conclusion → User Model → Policy。
                默认 Shadow：计算并记录，不改变真实 Agent Prompt。
                对话中明确保存的用户事实进入 Trylo 正式用户记忆；用户学习开关控制其可用性。Hermes Skill 学习使用独立开关。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.enabled}
                  onChange={(e) => set('userLearning', { ...form.userLearning, enabled: e.target.checked })}
                />
                <span className="settings-modal__label">Enable User Learning</span>
              </label>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.cognitionEnabled}
                  onChange={(e) => set('userLearning', { ...form.userLearning, cognitionEnabled: e.target.checked })}
                />
                <span className="settings-modal__label">Enable User Cognition</span>
              </label>
              <p className="settings-modal__hint">
                Team：打开后可从对话里「组一组」，或在团队表面选模板。默认关闭。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.teamAccessEnabled === true}
                  onChange={(e) => set('userLearning', {
                    ...form.userLearning,
                    teamAccessEnabled: e.target.checked,
                    teamComposerEnabled: e.target.checked,
                  })}
                />
                <span className="settings-modal__label">启用 Team（团队）</span>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">Policy mode</span>
                <select
                  className="settings-modal__input"
                  value={form.userLearning.defaultMode}
                  onChange={(e) => set('userLearning', {
                    ...form.userLearning,
                    defaultMode: e.target.value as TryloSettings['userLearning']['defaultMode'],
                  })}
                >
                  <option value="shadow">Shadow (log only)</option>
                  <option value="enforced">Enforced (inject Active Policy)</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <p className="settings-modal__hint">Per-dimension override (unset = use default mode)</p>
              {(['verification_audit', 'planning_direct_execution', 'reporting_information_density'] as const).map((dimension) => (
                <label key={dimension} className="settings-modal__field">
                  <span className="settings-modal__label">{dimension}</span>
                  <select
                    className="settings-modal__input"
                    value={form.userLearning.dimensionMode[dimension] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      const dimensionMode = { ...form.userLearning.dimensionMode };
                      if (!value) delete dimensionMode[dimension];
                      else dimensionMode[dimension] = value as TryloSettings['userLearning']['defaultMode'];
                      set('userLearning', { ...form.userLearning, dimensionMode });
                    }}
                  >
                    <option value="">Default</option>
                    <option value="shadow">Shadow</option>
                    <option value="enforced">Enforced</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              ))}
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">任务学习（Hermes）</legend>
              <p className="settings-modal__desc">
                Work 任务结束后镜像会话并可能提出 Skill。关闭只影响 Work；Code 与 User Learning 不变。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.hermesWorkLearning !== false}
                  onChange={(e) => set('hermesWorkLearning', e.target.checked)}
                />
                <span className="settings-modal__label">Work Hermes 任务学习</span>
              </label>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">技能 Skills</legend>
              <p className="settings-modal__desc">
                技能是代理的可复用工作手册（SOP）：任务中沉淀的方法、命令坑点、流程经验。
                新技能一律以「提案 → 你批准」的方式安装，已安装的技能可在技能库中查看全文。
              </p>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--ghost settings-modal__skills-open"
                onClick={() => setSkillsOpen(true)}
                disabled={!props.learningPort}
                title={props.learningPort ? '查看已安装技能' : '学习服务尚未就绪'}
              >
                打开技能库
              </button>
              <span className="settings-modal__hint">
                待审批的技能提案在顶栏「学习 → 代理学习 → 待审批」里批准后才会安装。
              </span>
            </fieldset>
          </>
        );

      case 'runtime':
        return (
          <fieldset className="settings-modal__group">
            <legend className="settings-modal__legend">Runtime</legend>

            <label className="settings-modal__field">
              <span className="settings-modal__label">CLI path</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={form.cliPath}
                onChange={(e) => set('cliPath', e.target.value)}
                placeholder={form.cliRuntimeProtocol === 'trylo-v1' ? '留空以自动解析新 CLI 入口' : settingsDefaults.cliPath}
              />
              <span className="settings-modal__hint">
                {form.cliRuntimeProtocol === 'trylo-v1'
                  ? '留空使用自动解析的新 CLI；也可填写自定义新 CLI 入口的绝对路径。'
                  : '旧 CLI 入口的绝对路径。'}
              </span>
            </label>
          </fieldset>
        );
    }
  };

  const navigationTab = settingsTab === 'subconnections' ? 'connection'
    : settingsTab === 'runtime' ? 'behavior' : settingsTab;
  const renderContent = (): ReactElement => {
    if (navigationTab === 'connection') {
      return <>{renderSection('connection')}{renderSection('subconnections')}</>;
    }
    if (navigationTab === 'behavior') {
      return <>{renderSection('behavior')}{renderSection('runtime')}</>;
    }
    return renderSection(navigationTab);
  };

  return (
    <div
      className="settings-modal__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <form className="settings-modal" onSubmit={onSave}>
        <header className="settings-modal__header">
          <h2 className="settings-modal__title">Settings</h2>
          <button
            type="button"
            className="settings-modal__close"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="settings-modal__body">
          <nav className="settings-modal__sidebar">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-modal__sidebar-item${navigationTab === tab.id ? ' settings-modal__sidebar-item--active' : ''}`}
                onClick={() => setSettingsTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal__content" key={navigationTab}>
            {renderContent()}
          </div>
        </div>
        <footer className="settings-modal__footer">
          {saveError && <p role="alert" className="settings-modal__test-result settings-modal__test-result--err">{saveError}</p>}
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="settings-modal__btn settings-modal__btn--primary"
          >
            Save
          </button>
        </footer>
      </form>

      {props.learningPort ? (
        <SkillsModal
          open={skillsOpen}
          port={props.learningPort}
          onClose={() => setSkillsOpen(false)}
          onOpenPending={props.onOpenLearningPending}
        />
      ) : null}
    </div>
  );
}
