import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { TryloSettings } from '../../settings/settings-store'
import type { TestConnectionResult } from '../../host-adapter/test-connection'
import { ReasoningEffortField } from './ReasoningEffortField'

export interface ModelConnectionFieldsProps {
  form: TryloSettings
  onChange: <K extends keyof TryloSettings>(key: K, value: TryloSettings[K]) => void
  onTest: () => void
  testing: boolean
  result: TestConnectionResult | null
  error: string | null
}

/** The everyday connection fields come first; custom auth stays available on demand. */
export function ModelConnectionFields({
  form,
  onChange,
  onTest,
  testing,
  result,
  error,
}: ModelConnectionFieldsProps): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const defaultHost =
    form.apiFormat === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'
  return (
    <>
      <fieldset className="settings-modal__group settings-connection">
        <legend className="settings-modal__legend">主模型连接</legend>
        <p className="settings-modal__desc">填写服务地址、模型和密钥，保存后用于新的请求。</p>
        <div className="settings-modal__columns">
          <label className="settings-modal__field">
            <span className="settings-modal__label">API 协议</span>
            <select
              className="settings-modal__input"
              value={form.apiFormat}
              onChange={(e) => onChange('apiFormat', e.target.value as TryloSettings['apiFormat'])}
            >
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
          </label>
          <label className="settings-modal__field">
            <span className="settings-modal__label">模型名称</span>
            <input
              className="settings-modal__input"
              value={form.apiModel}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange('apiModel', e.target.value)}
              placeholder="填写服务商提供的模型 ID"
            />
          </label>
        </div>
        <ReasoningEffortField form={form} onChange={value => onChange('reasoningEffort', value)} />
      <div className="settings-modal__field">
        <label className="settings-modal__label" htmlFor="primary-api-host">服务地址</label>
          <input
          id="primary-api-host"
          aria-describedby="primary-api-host-hint"
            className="settings-modal__input"
            type="url"
            value={form.apiHost}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange('apiHost', e.target.value)}
            placeholder={defaultHost}
          />
        <span id="primary-api-host-hint" className="settings-modal__hint">
            填写 API 的基础地址，保留服务商要求的 /v1 等路径。
          </span>
      </div>
        <div className="settings-modal__field">
          <label className="settings-modal__label" htmlFor="primary-api-key">
            API 密钥
          </label>
          <div className="settings-modal__secret">
            <input
              id="primary-api-key"
              className="settings-modal__input"
              type={showKey ? 'text' : 'password'}
              value={form.apiKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange('apiKey', e.target.value)}
              placeholder="粘贴 API Key"
            />
            <button
              type="button"
              className="settings-modal__secret-toggle"
              aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              aria-pressed={showKey}
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div className="settings-modal__probe">
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--ghost"
            onClick={onTest}
            disabled={testing}
          >
            {testing ? '正在检查…' : '检查服务可达性'}
          </button>
          <span className="settings-modal__hint">仅检查服务响应，不验证密钥和模型调用。</span>
        </div>
        {result && (
          <div
            role="status"
            className={`settings-modal__test-result settings-modal__test-result--${result.ok ? 'ok' : 'err'}`}
          >
            <strong>{result.ok ? '服务已响应' : '服务检查未通过'}</strong>
            <br />
            {result.message}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="settings-modal__test-result settings-modal__test-result--err"
          >
            检查失败：{error}
          </div>
        )}
      </fieldset>
      <details className="settings-modal__advanced">
        <summary>
          高级连接选项<span>自定义认证与请求头</span>
        </summary>
        <div className="settings-modal__advanced-body">
          <p className="settings-modal__desc">一般无需修改。仅在服务商要求时填写。</p>
          <label className="settings-modal__field">
            <span className="settings-modal__label">服务商标识</span>
            <input
              className="settings-modal__input"
              value={form.providerId}
              onChange={(e) => onChange('providerId', e.target.value)}
              placeholder="可选，如 openai、ollama"
            />
          </label>
          <div className="settings-modal__columns">
            <label className="settings-modal__field">
              <span className="settings-modal__label">认证请求头</span>
              <input
                className="settings-modal__input"
                value={form.apiKeyHeader}
                onChange={(e) => onChange('apiKeyHeader', e.target.value)}
                placeholder="Authorization"
              />
            </label>
            <label className="settings-modal__field">
              <span className="settings-modal__label">密钥前缀</span>
              <input
                className="settings-modal__input"
                value={form.apiKeyPrefix}
                onChange={(e) => onChange('apiKeyPrefix', e.target.value)}
                placeholder="Bearer "
              />
            </label>
          </div>
          <label className="settings-modal__field">
            <span className="settings-modal__label">额外请求头（JSON）</span>
            <textarea
              className="settings-modal__input settings-modal__textarea"
              value={form.extraHeadersText}
              spellCheck={false}
              onChange={(e) => onChange('extraHeadersText', e.target.value)}
              placeholder={'{"X-Custom":"value"}'}
            />
          </label>
        </div>
      </details>
    </>
  )
}
