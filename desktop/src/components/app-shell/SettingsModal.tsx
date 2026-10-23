import { ModelConnectionFields } from './ModelConnectionFields';
import { reasoningSelectionProblem } from '../../settings/reasoning-effort';
import { X, Plug, Palette, SlidersHorizontal, Wrench, Smartphone, BookOpen, type LucideIcon } from 'lucide-react';
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
// Custom headers are validated before persistence. No
// test-connection beyond the per-host TCP probe. Phase 3
// features (encrypted secret store, full HTTP test,
// "auto-detect best model") belong in Phase 3.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
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
import { isNewCliOnlyDistribution, type CliRuntimeProtocol } from '../../runtime/cli-runtime-protocol';
import { testConnection, type TestConnectionResult } from '../../host-adapter/test-connection';
import type {
  PetStatusSnapshot,
  RemoteStatusResult,
} from '../../services-host/methods';
import { petStatusDetail, petStatusHeadline, petStatusTone } from '../../companion/pet-status-text';
import { WorkToolsSettings } from './WorkToolsSettings';
import type { DesktopAccountPort } from '../../account/desktop-account';
import { SkillsModal } from './SkillsModal';
import type { LearningPort } from '../../learning/learning-port';
import {
  derivePackageView,
  type ToolPlatformState,
} from '../../tooling/use-tool-platform-state';

export type SettingsTab = 'connection' | 'appearance' | 'behavior' | 'tools' | 'remote' | 'subconnections' | 'learning' | 'runtime';

const SETTINGS_TABS: readonly { id: SettingsTab; label: string; description: string; Icon: LucideIcon }[] = [
  { id: 'connection', label: '模型连接', description: '管理模型服务和常用连接配置。', Icon: Plug },
  { id: 'appearance', label: '外观', description: '调整界面主题，让工作更舒适。', Icon: Palette },
  { id: 'behavior', label: '行为与运行', description: '设置任务权限与运行方式。', Icon: SlidersHorizontal },
  { id: 'tools', label: '工具与控制', description: '管理工具能力与依赖包。', Icon: Wrench },
  { id: 'remote', label: '远程', description: '连接手机与远程工作环境。', Icon: Smartphone },
  { id: 'learning', label: '学习', description: '管理学习偏好与已安装技能。', Icon: BookOpen },
];

export interface RelayAccountActions extends DesktopAccountPort {
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
  const testGeneration = useRef(0);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const dialogRef = useRef<HTMLFormElement>(null);
  const toolSelectionRef = useRef<HTMLDetailsElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  // Sidebar tab state
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  // Remote pairing QR moved to the TopBar "远程" button
  // (RemotePairingModal) — 2026-08-29. Settings keeps only
  // the gateway *configuration* (port / tunnel / URL).

  useEffect(() => {
    testGeneration.current += 1;
    setTesting(false);
    if (props.open) {
      setSettingsTab(props.initialTab ?? 'connection');
      setForm(toFormState(props.initial));
      setTestResult(null);
      setTestError(null);
      setSaveError(null);
      setProfileName('');
    }
    return () => { testGeneration.current += 1; };
  }, [props.open, props.initial, props.initialTab]);

  useEffect(() => {
    if (!props.open || skillsOpen) return;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [props.open, skillsOpen]);

  if (!props.open) return null;

  const set = <K extends keyof TryloSettings>(k: K, v: TryloSettings[K]): void => {
    testGeneration.current += 1;
    setTesting(false);
    setTestResult(null);
    setTestError(null);
    setSaveError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const setSub = (
    which: 'vision' | 'summary',
    k: keyof SubConnection,
    v: SubConnection[typeof k],
  ): void => {
    setSaveError(null);
    setForm((f) => ({
      ...f,
      [which]: { ...f[which], [k]: v },
    }));
  };

  const onTest = async (): Promise<void> => {
    const generation = ++testGeneration.current;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await testConnection({
        apiHost: form.apiHost || (form.apiFormat === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'),
        apiKey: form.apiKey,
        apiFormat: form.apiFormat,
      });
      if (generation === testGeneration.current) setTestResult(r);
    } catch (err) {
      if (generation === testGeneration.current) setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === testGeneration.current) setTesting(false);
    }
  };

  const onSave = (e: FormEvent): void => {
    e.preventDefault();
    const reasoningProblem = reasoningSelectionProblem(form);
    if (reasoningProblem) { setSaveError(reasoningProblem); return; }
    for (const [name, headers] of [
      ['主模型', form.extraHeadersText],
      ...(!form.vision.usePrimaryConnection ? [['视觉模型', form.vision.extraHeadersText]] : []),
      ...(!form.summary.usePrimaryConnection ? [['摘要模型', form.summary.extraHeadersText]] : []),
    ]) {
      try {
        const value: unknown = JSON.parse(headers || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
      } catch {
        setSaveError(`${name}的额外请求头需要是 JSON 对象，且每个值都是文本。请检查高级连接选项。`);
        return;
      }
    }
    const connectionChanged = JSON.stringify(connectionFields(form)) !== JSON.stringify(connectionFields(props.initial))
      || form.activeModelProfileId !== props.initial.activeModelProfileId;
    const intent: SettingsSaveIntent = connectionChanged || navigationTab === 'connection' ? 'connection' : 'preferences';
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
    setSaveError(null);
    if (!id) { set('activeModelProfileId', ''); return; }
    const p = form.modelProfiles.find((x) => x.id === id);
    if (p) {
      testGeneration.current += 1; setTesting(false); setTestResult(null); setTestError(null);
      setForm((f) => applyProfile(f, p));
    }
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
          <span className="settings-modal__label">沿用主模型连接</span>
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
            {form.modelProfiles.length > 0 && <label className="settings-modal__field">
              <span className="settings-modal__label">已保存的配置</span>
              <select className="settings-modal__input" value={form.modelProfiles.some(profile => profile.id === form.activeModelProfileId && JSON.stringify(connectionFields(profile)) === JSON.stringify(connectionFields(form))) ? form.activeModelProfileId : ''}
                onChange={event => handleApplyProfile(event.target.value)}>
                <option value="">自定义连接</option>
                {form.modelProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.apiModel || '默认模型'}</option>)}
              </select>
              <span className="settings-modal__hint">选择后载入表单，点击“保存设置”应用。</span>
            </label>}
            <ModelConnectionFields form={form} onChange={set} onTest={() => void onTest()}
              testing={testing} result={testResult} error={testError} />

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
                  aria-label="新配置名称"
                  placeholder="为这组连接起个名字"
                />
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--ghost"
                  onClick={handleAddProfile}
                  disabled={!profileName.trim()}
                >
                  添加配置
                </button>
              </div>
              {form.modelProfiles.length === 0 ? (
                <span className="settings-modal__hint">
                  还没有配置。填写主模型连接后，命名并添加，方便下次切换。
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
                          {isActive && JSON.stringify(connectionFields(p)) === JSON.stringify(connectionFields(form)) ? ' · 已载入表单' : ''}
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
              <legend className="settings-modal__legend">任务与权限</legend>

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
                  {!isNewCliOnlyDistribution() && <option value="legacy-stream-json">旧 CLI — legacy-stream-json</option>}
                    <option value="trylo-v1">新 CLI — trylo-v1</option>
                </select>
                <span className="settings-modal__hint">
                  保存后用于下一次启动任务；已有运行中的任务沿用原 CLI。
                  {isNewCliOnlyDistribution() ? '此版本仅包含新版 Trylo CLI。' : '切换时会同步选择对应入口，自定义路径可在下方 CLI path 中调整。'}
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">系统提示词</span>
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
              <legend className="settings-modal__legend">桌面伙伴</legend>

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.companion.enabled}
                  onChange={(e) => set('companion', { ...form.companion, enabled: e.target.checked })}
                />
                <span className="settings-modal__label">启用桌面伙伴</span>
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
            <WorkToolsSettings platform={props.toolPlatform} selection={{ computer: form.workComputer, browserDebug: form.workBrowserDebug, cad: form.workCad }} onConfigure={() => {
              const details = toolSelectionRef.current;
              if (!details) return;
              details.open = true;
              details.scrollIntoView({ block: 'start' });
              details.querySelector('input')?.focus({ preventScroll: true });
            }} />

            <details ref={toolSelectionRef} className="settings-modal__advanced" open><summary>能力选择<span>选择后保存，用于后续 Work 任务</span></summary><div className="settings-modal__advanced-body">

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
                  ? '关闭时使用 Playwright；开启后改用 Chrome DevTools。可以与 CAD/EDA 同时启用，办公与桌面控制能力按各自配置保留。工具操作仍遵循当前授权规则。'
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
                  ? '开启后为后续任务选用 CAD/EDA 适配器；还需要对应的软件与连接环境就绪。可以同时启用浏览器调试。工具包安装、实际可用与本次配置是否选用是不同状态，可在上方逐项查看。'
                  : '不支持此平台 — CAD/EDA 适配器是 Windows-only 能力。'}
              </span>

              {form.workCad && props.toolPlatform ? (
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
            </div></details>
          </>
        );

      case 'remote':
        return <fieldset className="settings-modal__group"><legend>远程与连接</legend><p>账号登录、服务器与独立隧道切换、手机配对已集中到同一个窗口。</p><button type="button" className="settings-modal__button" onClick={() => props.onOpenRemote?.()}>打开远程与连接</button></fieldset>;

      case 'subconnections':
        return (
          <>
            {renderSubConnection(
              'vision',
              '视觉模型',
              '用于读取图片。默认沿用主模型，也可以配置独立的模型、地址和密钥。',
            )}
            {renderSubConnection(
              'summary',
              '摘要模型',
              '用于压缩长对话。默认沿用主模型，也可以单独配置。',
            )}
          </>
        );

      case 'learning':
        return (
          <>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">用户学习</legend>
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
            <legend className="settings-modal__legend">运行环境</legend>

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
      return <>{renderSection('connection')}<details className="settings-modal__advanced" open={settingsTab === 'subconnections'}><summary>视觉与摘要模型<span>默认沿用主模型连接</span></summary><div className="settings-modal__advanced-body">{renderSection('subconnections')}</div></details></>;
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
      aria-label="设置"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <form ref={dialogRef} className="settings-modal" onSubmit={onSave}>
        <header className="settings-modal__header">
          <h2 className="settings-modal__title">设置</h2><span className="settings-modal__product">Trylo</span>
          <button
            type="button"
            className="settings-modal__close"
            onClick={props.onClose}
            aria-label="关闭设置"
          >
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal__body">
          <nav className="settings-modal__sidebar" aria-label="设置分类">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-modal__sidebar-item${navigationTab === tab.id ? ' settings-modal__sidebar-item--active' : ''}`}
                aria-current={navigationTab === tab.id ? 'page' : undefined}
                onClick={() => setSettingsTab(tab.id)}
              >
                <tab.Icon size={17} aria-hidden="true" />
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal__content" key={navigationTab}>
            <div className="settings-modal__page-heading"><h3>{SETTINGS_TABS.find(tab => tab.id === navigationTab)?.label}</h3><p>{SETTINGS_TABS.find(tab => tab.id === navigationTab)?.description}</p></div>
            {renderContent()}
          </div>
        </div>
        <footer className="settings-modal__footer">
          <span className="settings-modal__footer-note">{navigationTab === 'appearance' ? '外观即时生效；其他修改需保存。' : '保存后应用修改。'}</span>
          {saveError && <p role="alert" className="settings-modal__test-result settings-modal__test-result--err">{saveError}</p>}
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="settings-modal__btn settings-modal__btn--primary"
          >
            保存设置
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
