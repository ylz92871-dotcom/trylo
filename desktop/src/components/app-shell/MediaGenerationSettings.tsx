import { Eye, EyeOff, Image, Video } from 'lucide-react'
import { useState } from 'react'
import { IMAGE_GENERATION_PROTOCOLS, VIDEO_GENERATION_PROTOCOLS, mediaGenerationSettings,
  type MediaGenerationSettings as Settings, type MediaConnectionSettings } from '../../settings/media-generation'

export function MediaGenerationSettings({ value, onChange }: { readonly value: Settings | undefined; readonly onChange: (value: Settings) => void }): JSX.Element {
  const settings = mediaGenerationSettings(value)
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string>>(new Set())
  const field = (kind: 'image' | 'video', update: Partial<MediaConnectionSettings>): void => onChange({ ...settings, [kind]: { ...settings[kind], ...update } })
  return <>
    <p className="settings-modal__desc">图片与视频使用独立连接，不会改动聊天模型。生成结果保存在任务目录，并在对话中显示。</p>
    {(['image', 'video'] as const).map(kind => {
      const connection = settings[kind], options = kind === 'image' ? IMAGE_GENERATION_PROTOCOLS : VIDEO_GENERATION_PROTOCOLS
      const title = kind === 'image' ? '图片生成' : '视频生成', Icon = kind === 'image' ? Image : Video
      const preset = options.find(item => item.value === connection.protocol)
      return <fieldset className="settings-modal__group" key={kind}>
        <legend className="settings-modal__legend"><Icon size={15} aria-hidden="true" /> {title}</legend>
        <label className="settings-modal__field"><span><input type="checkbox" checked={connection.enabled} onChange={event => field(kind, { enabled: event.target.checked })} />启用{title} API</span></label>
        <label className="settings-modal__field"><span className="settings-modal__label">{title}接口格式</span>
          <select className="settings-modal__input" value={connection.protocol} onChange={event => {
            const next = options.find(item => item.value === event.target.value)
            if (next) field(kind, { protocol: next.value, ...(connection.endpoint === '' || connection.endpoint === preset?.endpoint ? { endpoint: next.endpoint } : {}) })
          }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="settings-modal__field"><span className="settings-modal__label">{title}服务地址</span>
          <input className="settings-modal__input" type="url" value={connection.endpoint} required={connection.enabled} placeholder={preset?.endpoint}
            spellCheck={false} autoComplete="off" onChange={event => field(kind, { endpoint: event.target.value })} /></label>
        <label className="settings-modal__field"><span className="settings-modal__label">{title}模型 ID</span>
          <input className="settings-modal__input" value={connection.model} required={connection.enabled} placeholder={connection.protocol === 'replicate-video' ? 'owner/model' : '填写服务商提供的模型 ID'}
            spellCheck={false} autoComplete="off" onChange={event => field(kind, { model: event.target.value })} /></label>
        <div className="settings-modal__field"><label className="settings-modal__label" htmlFor={`media-key-${kind}`}>{title} API 密钥</label>
          <div className="settings-modal__secret"><input id={`media-key-${kind}`} className="settings-modal__input" type={visibleKeys.has(kind) ? 'text' : 'password'} value={connection.apiKey}
            autoComplete="off" spellCheck={false} onChange={event => field(kind, { apiKey: event.target.value })} />
            <button type="button" className="settings-modal__secret-toggle" aria-label={`${visibleKeys.has(kind) ? '隐藏' : '显示'}${title}密钥`}
              onClick={() => setVisibleKeys(previous => { const next = new Set(previous); if (next.has(kind)) next.delete(kind); else next.add(kind); return next })}>
              {visibleKeys.has(kind) ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>
        <p className="settings-modal__hint">按当前服务商与模型实际能力调用；启用不会自动生成或消耗额度。</p>
      </fieldset>
    })}
    <fieldset className="settings-modal__group"><legend className="settings-modal__legend">没有 API 时</legend>
      <label className="settings-modal__field"><span><input type="checkbox" checked={settings.browserFallback} onChange={event => onChange({ ...settings, browserFallback: event.target.checked })} />允许建议通过网页账号创作</span></label>
      <p className="settings-modal__desc">Trylo 会先询问你有哪些可用账号，并让你接管浏览器登录。官方 skill 按需加载，登录信息不用发到对话中。</p>
    </fieldset>
  </>
}
