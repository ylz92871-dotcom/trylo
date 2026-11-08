import { useId, useState } from 'react'
import type {
  ExpertBaseRole,
  ExpertConfiguration,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'

import { EXPERT_ROLE_LABELS } from './presentation'
const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

export function ExpertConfigurationEditor({
  configuration,
  disabled,
  onApply,
  onDirty,
}: {
  readonly configuration: ExpertConfiguration
  readonly disabled: boolean
  readonly onApply: (edits: Partial<ExpertConfiguration>) => Promise<void>
  readonly onDirty: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(configuration)
  const [rawLists, setRawLists] = useState({
    situations: configuration.situations.join('\n'),
    responsibilities: configuration.responsibilities.join('\n'),
    constraints: configuration.constraints.join('\n'),
    collaboration: configuration.collaboration.join('\n'),
    toolRefs: configuration.toolRefs.join('\n'),
    skills: (configuration.role.skills ?? []).join('\n'),
    allowedTools: (configuration.role.allowedTools ?? []).join('\n'),
    disallowedTools: (configuration.role.disallowedTools ?? []).join('\n'),
  })
  const [toolPolicy, setToolPolicy] = useState<'inherit' | 'selected'>(
    configuration.role.allowedTools === undefined ? 'inherit' : 'selected',
  )
  const changeList = (key: keyof typeof rawLists, value: string) =>
    setRawLists((previous) => ({ ...previous, [key]: value }))
  const change = <K extends keyof ExpertConfiguration>(key: K, value: ExpertConfiguration[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const listField = (
    key: 'situations' | 'responsibilities' | 'constraints' | 'collaboration' | 'toolRefs',
    label: string,
  ) => (
    <label>
      <span>{label}</span>
      <textarea
        disabled={disabled}
        rows={key === 'toolRefs' ? 2 : 3}
        value={rawLists[key]}
        onChange={(event) => changeList(key, event.target.value)}
      />
    </label>
  )
  return (
    <form
      className="expert-config"
      onChange={onDirty}
      onSubmit={(event) => {
        event.preventDefault()
        const role = { ...draft.role }
        if (rawLists.skills !== (configuration.role.skills ?? []).join('\n'))
          role.skills = lines(rawLists.skills)
        if (rawLists.disallowedTools !== (configuration.role.disallowedTools ?? []).join('\n'))
          role.disallowedTools = lines(rawLists.disallowedTools)
        if (toolPolicy === 'selected') role.allowedTools = lines(rawLists.allowedTools)
        else delete role.allowedTools
        const next = {
          ...draft,
          role,
          situations: lines(rawLists.situations),
          responsibilities: lines(rawLists.responsibilities),
          constraints: lines(rawLists.constraints),
          collaboration: lines(rawLists.collaboration),
          toolRefs: lines(rawLists.toolRefs),
        }
        // Only user-changed fields become durable overrides; generated fields stay revisable.
        const edits: Partial<ExpertConfiguration> = {}
        for (const key of Object.keys(next) as (keyof ExpertConfiguration)[]) {
          if (JSON.stringify(next[key]) !== JSON.stringify(configuration[key]))
            Object.assign(edits, { [key]: next[key] })
        }
        void onApply(edits)
      }}
    >
      <fieldset disabled={disabled}>
        <legend>专业配置</legend>
        <div className="expert-config__columns">
          <label>
            <span>专家名称</span>
            <input
              required
              maxLength={24}
              value={draft.displayName}
              onChange={(event) => change('displayName', event.target.value)}
            />
          </label>
          <label>
            <span>基础席位</span>
            <select
              value={draft.baseRole}
              onChange={(event) => {
                const baseRole = event.target.value as ExpertBaseRole
                setDraft((previous) => ({
                  ...previous,
                  baseRole,
                  role: { ...previous.role, name: baseRole },
                }))
              }}
            >
              {Object.entries(EXPERT_ROLE_LABELS).map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span>专项能力</span>
          <textarea
            required
            rows={2}
            value={draft.specialty}
            onChange={(event) => change('specialty', event.target.value)}
          />
        </label>
        <div className="expert-config__columns">
          {listField('situations', '适用情境（每行一项）')}
          {listField('responsibilities', '职责（每行一项）')}
        </div>
        <div className="expert-config__columns">
          {listField('constraints', '必须遵守的约束（每行一项）')}
          {listField('collaboration', '协作与交接要求（每行一项）')}
        </div>
        <details>
          <summary>工具、技能与执行配置</summary>
          <p className="expert-library__hint">
            工具引用将在派发时解析。角色限制、父级授权和技能限制仍然适用。
          </p>
          {listField('toolRefs', '工具库引用（每行一项）')}
          <label>
            <span>已安装技能名称（每行一项）</span>
            <textarea
              rows={2}
              value={rawLists.skills}
              onChange={(event) => changeList('skills', event.target.value)}
            />
          </label>
          <label>
            <span>允许工具的方式</span>
            <select
              value={toolPolicy}
              onChange={(event) => setToolPolicy(event.target.value as 'inherit' | 'selected')}
            >
              <option value="inherit">沿用基础席位允许的工具</option>
              <option value="selected">仅允许列出的工具（空列表禁用全部）</option>
            </select>
          </label>
          <div className="expert-config__columns">
            <label>
              <span>允许的执行工具（每行一项）</span>
              <textarea
                rows={2}
                disabled={toolPolicy === 'inherit'}
                value={rawLists.allowedTools}
                onChange={(event) => changeList('allowedTools', event.target.value)}
              />
            </label>
            <label>
              <span>禁用的执行工具（每行一项）</span>
              <textarea
                rows={2}
                value={rawLists.disallowedTools}
                onChange={(event) => changeList('disallowedTools', event.target.value)}
              />
            </label>
          </div>
          <label>
            <span>模型（留空则继承）</span>
            <input
              value={draft.role.model ?? ''}
              onChange={(event) => {
                const role = { ...draft.role }
                if (event.target.value.trim()) role.model = event.target.value
                else delete role.model
                change('role', role)
              }}
            />
          </label>
          <label>
            <span>补充执行说明</span>
            <textarea
              rows={3}
              value={draft.role.prompt ?? ''}
              onChange={(event) => {
                const role = { ...draft.role }
                if (event.target.value.trim()) role.prompt = event.target.value
                else delete role.prompt
                change('role', role)
              }}
            />
          </label>
        </details>
        <details>
          <summary>专项方法与来源</summary>
          {draft.methods.map((method, index) => (
            <div key={index} className="expert-method">
              <label>
                <span>方法名称 {index + 1}</span>
                <input
                  required
                  value={method.title}
                  onChange={(event) =>
                    change(
                      'methods',
                      draft.methods.map((item, at) =>
                        at === index ? { ...item, title: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>方法步骤 {index + 1}</span>
                <textarea
                  required
                  rows={3}
                  value={method.instructions}
                  onChange={(event) =>
                    change(
                      'methods',
                      draft.methods.map((item, at) =>
                        at === index ? { ...item, instructions: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>方法依据 {index + 1}</span>
                <select
                  multiple
                  value={[...method.sourceUris]}
                  onChange={(event) =>
                    change(
                      'methods',
                      draft.methods.map((item, at) =>
                        at === index
                          ? {
                              ...item,
                              sourceUris: Array.from(
                                event.target.selectedOptions,
                                (option) => option.value,
                              ),
                            }
                          : item,
                      ),
                    )
                  }
                >
                  {draft.sources.map((source) => (
                    <option key={source.uri} value={source.uri}>
                      {source.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
          <p className="expert-library__hint">
            新增方法或专业资料可在上方用自然语言提出，构建后重新审核。
          </p>
          <ul className="expert-sources">
            {draft.sources.map((source) => (
              <li key={source.uri}>
                <strong>{source.title}</strong>
                <span>{source.uri}</span>
                <p>{source.excerpt}</p>
              </li>
            ))}
          </ul>
        </details>
        <p id={`${id}-priority`} className="expert-library__hint">
          你明确修改的配置将被保留，后续自动构建会继续遵守。
        </p>
        <button type="submit" className="expert-button" aria-describedby={`${id}-priority`}>
          应用配置修改
        </button>
      </fieldset>
    </form>
  )
}
