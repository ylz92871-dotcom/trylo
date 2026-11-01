import type { ProductionDetail } from '../../tool-learning/production-contract'
const stages: Readonly<Record<string, string>> = {
  source_license_provenance: '来源与许可',
  archive_path_manifest_schema: '依赖与接口',
  static_secret_malware_api: '静态材料检查',
  type_build_unit: '来源样例',
  sandbox_smoke: '隔离启动',
  permission_malicious_bounds: '权限边界',
  cancel_timeout_crash: '取消与崩溃',
  idempotency_side_effects: '重复调用',
  baseline_regression: '变式与反例',
  independent_verdict: '独立检查结论',
}
function sourceHref(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

export function ToolProductionEvidence({ detail }: { readonly detail: ProductionDetail }) {
  return (
    <>
      <section>
        <h4>
          验证依据{' '}
          <span className="tool-production__meta">
            {detail.review.status === 'available' ? '当前收据有效' : '当前不可启用'}
          </span>
        </h4>
        {detail.report ? (
          <>
            <p>
              历史检查 {detail.report.stages.filter((item) => item.passed).length} / 10
              项通过。启用仍以当前收据和审批为准。
            </p>
            <details>
              <summary>展开检查记录</summary>
              <ol className="tool-production__stages">
                {detail.report.stages.map((item) => (
                  <li key={item.stage}>
                    <div>
                      <span>{stages[item.stage]}</span>
                      <span>{item.passed ? '通过' : '未通过'}</span>
                    </div>
                    <p>{item.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <p>尚无已完成的生产检查记录。验证通过后仍需你单独批准启用。</p>
        )}
        {detail.review.status === 'available' ? (
          <details>
            <summary>收据与版本标识</summary>
            <dl>
              <dt>验证收据</dt>
              <dd>
                <code>{detail.review.receiptId}</code>
              </dd>
              <dt>精确版本</dt>
              <dd>
                <code>{detail.versionId}</code>
              </dd>
              <dt>本次审阅</dt>
              <dd>
                <code>{detail.review.reviewId}</code>
              </dd>
            </dl>
          </details>
        ) : (
          <p className="tool-production__meta">{detail.review.code}</p>
        )}
      </section>
      <section>
        <h4>来源与许可</h4>
        <p>
          {detail.source.length} 个来源记录。
          {detail.profile === 'confined_json_function_v1'
            ? '来自已归档生成候选。'
            : 'npm 发布归档与许可摘要已冻结；来源修订为人工审阅记录。'}
        </p>
        <details>
          <summary>查看完整来源记录</summary>
          <ul className="tool-production__sources">
            {detail.source.map((item, i) => (
              <li key={i}>
                <strong>
                  {item.name}{' '}
                  <span>
                    {item.version} · {item.license}
                  </span>
                </strong>
                {item.origin === 'reviewed_npm_archive' ? (
                  <>
                    <p>
                      {sourceHref(item.upstreamUrl) ? (
                        <a href={sourceHref(item.upstreamUrl)} target="_blank" rel="noreferrer">
                          {item.upstreamUrl}
                        </a>
                      ) : (
                        item.upstreamUrl
                      )}
                    </p>
                    <dl>
                      <dt>安装位置</dt>
                      <dd>
                        <code>{item.location}</code>
                      </dd>
                      <dt>来源修订</dt>
                      <dd>
                        <code>{item.sourceRevision}</code>
                      </dd>
                      <dt>归档 SHA256</dt>
                      <dd>
                        <code>{item.archiveSha256}</code>
                      </dd>
                      {item.licenses.map((license) => (
                        <div className="tool-production__license" key={license.path}>
                          <dt>{license.path}</dt>
                          <dd>
                            <code>{license.sha256}</code>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : (
                  <dl>
                    <dt>生成候选</dt>
                    <dd>
                      <code>{item.sourceVersionId}</code>
                    </dd>
                    <dt>内容摘要</dt>
                    <dd>
                      <code>{item.contentHash}</code>
                    </dd>
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </>
  )
}
