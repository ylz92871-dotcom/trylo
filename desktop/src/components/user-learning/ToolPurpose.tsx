import type { ProductionDetail, ProductionSummary } from '../../tool-learning/production-contract'

const runtimeLabels: Record<ProductionSummary['profile'], string> = {
  confined_json_function_v1: '本地函数工具',
  confined_npm_cli_v1: '本地命令行工具',
  confined_npm_mcp_v1: '本地工具服务',
}
export const toolRuntimeLabel = (profile: ProductionSummary['profile']): string =>
  runtimeLabels[profile]

/** A list excerpt; the detail and approval retain the complete supplied description. */
export function toolPurposeLabel(description: string): string {
  const end = description.search(/[。！？\n]/u)
  return end < 0 ? description : description.slice(0, end + 1).trim()
}

/** Operator-facing copy comes from the reviewed proposal, with no inferred task context or package-name guess. */
export function ToolPurposeDescription({ description }: Pick<ProductionDetail, 'description'>) {
  return <p className="tool-production__purpose-description">{description}</p>
}

export function ToolPurposeConditions({ mastery }: Pick<ProductionDetail, 'mastery'>) {
  return (
    <div className="tool-production__purpose-conditions">
      <section aria-label="工具适用场景">
        <h4>什么时候会用</h4>
        {mastery.whenToUse.length ? (
          <ul>
            {mastery.whenToUse.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : (
          <p>提案尚未提供适用场景说明。</p>
        )}
      </section>
      {mastery.preconditions.length ? (
        <section>
          <h4>需要提供什么</h4>
          <ul>
            {mastery.preconditions.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {mastery.pitfalls.length ? (
        <section>
          <h4>使用限制</h4>
          <ul>
            {mastery.pitfalls.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
