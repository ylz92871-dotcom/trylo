import type { ProductionDetail, ProductionSource } from '../../tool-learning/production-contract'

function sourceHref(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['github.com', 'registry.npmjs.org'].includes(url.hostname) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
function NpmSource({ item }: { readonly item: Extract<ProductionSource, { readonly origin: 'reviewed_npm_archive' }> }) {
  const registry = item.sourceIdentity?.kind === 'registry_archive' ? item.sourceIdentity : undefined
  const url = registry?.archiveUrl ?? item.upstreamUrl, href = sourceHref(url)
  return <>
    <p>{href ? <a href={href} target="_blank" rel="noreferrer">{url}</a> : url}</p>
    {registry ? <p>按精确发布归档核对内容。仓库与修订号若有，属于发布者声明。</p> : <p>保留的旧版来源指针；不代表已核验仓库修订。</p>}
    <dl>
      <dt>安装位置</dt><dd><code>{item.location}</code></dd>
      {registry ? <><dt>归档完整性</dt><dd><code>{registry.integrity}</code></dd>
        {registry.claims?.repository ? <><dt>发布者声明的仓库</dt><dd>{registry.claims.repository}</dd></> : null}
        {registry.claims?.revision ? <><dt>发布者声明的修订</dt><dd><code>{registry.claims.revision}</code></dd></> : null}
      </> : <><dt>来源修订指针</dt><dd><code>{item.sourceRevision}</code></dd></>}
      <dt>归档 SHA256</dt><dd><code>{item.archiveSha256}</code></dd>
      {item.licenses.map(license => <div className="tool-production__license" key={license.path}><dt>{license.path}</dt><dd><code>{license.sha256}</code></dd></div>)}
    </dl>
  </>
}
export function ToolProductionSources({ detail }: { readonly detail: ProductionDetail }) {
  const adaptation = detail.adaptation
  return <section>
    <h4>来源与许可</h4>
    <p>{detail.source.length} 个来源记录。{detail.profile === 'confined_json_function_v1' ? '来自已归档生成候选。' : 'npm 发布归档、依赖和许可摘要已冻结。'}</p>
    {adaptation && (adaptation.adapterContentHash || adaptation.patchedFiles.length || adaptation.parent) ? <details>
      <summary>查看适配与修改记录</summary>
      <dl>
        {adaptation.adapterContentHash ? <><dt>适配代码摘要</dt><dd><code>{adaptation.adapterContentHash}</code></dd></> : null}
        {adaptation.parent ? <><dt>改进依据</dt><dd>{adaptation.parent.adaptation}</dd><dt>父版本</dt><dd><code>{adaptation.parent.parentVersionId}</code></dd></> : null}
      </dl>
      {adaptation.patchedFiles.length ? <ul className="tool-production__sources">{adaptation.patchedFiles.map(file => <li key={file.path}>
        <strong>{file.path}</strong><dl><dt>原始文件 SHA256</dt><dd><code>{file.upstreamSha256}</code></dd><dt>新内容摘要</dt><dd><code>{file.replacementContentHash}</code></dd></dl>
      </li>)}</ul> : <p>此版本没有替换上游源码文件。</p>}
    </details> : null}
    <details>
      <summary>查看完整来源记录</summary>
      <ul className="tool-production__sources">{detail.source.map((item, index) => <li key={index}>
        <strong>{item.name} <span>{item.version} · {item.license}</span></strong>
        {item.origin === 'reviewed_npm_archive' ? <NpmSource item={item} /> : <dl>
          <dt>生成候选</dt><dd><code>{item.sourceVersionId}</code></dd><dt>内容摘要</dt><dd><code>{item.contentHash}</code></dd>
        </dl>}
      </li>)}</ul>
    </details>
  </section>
}
