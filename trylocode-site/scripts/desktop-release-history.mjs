const repository = 'https://github.com/ylz92871-dotcom/trylo/releases/';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Render published artifacts only; releases without an installer stay that way. */
export function desktopReleaseHistory(history = []) {
  if (!history.length) return '';
  const rows = history.map(release => {
    if (!/^desktop-v\d+\.\d+\.\d+(?:-r\d+)?$/.test(release.tag)
        || release.releaseNotes !== repository + 'tag/' + release.tag
        || !/^\d{4}-\d{2}-\d{2}$/.test(release.date)) throw new Error('Unexpected historical release');
    const downloads = release.artifacts.map(artifact => {
      const expected = repository + 'download/' + release.tag + '/' + artifact.file;
      const local = release.tag === 'desktop-v1.0.6' && artifact.file === 'Trylo_1.0.6_x64-setup.exe'
        ? '/download/desktop/releases/1.0.6/' + artifact.file : null;
      if (!/^Trylo[-_][A-Za-z0-9._-]+\.(?:exe|zip)$/.test(artifact.file)
          || !['安装包', '便携包'].includes(artifact.label)
          || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
          || (artifact.url !== expected && artifact.url !== local)) throw new Error('Unexpected historical artifact');
      return `<a href="${escape(artifact.url)}">${artifact.label} <span>${Math.round(artifact.bytes / 1048576)} MB</span></a>`;
    }).join('');
    if (!downloads) throw new Error('Historical release has no downloads');
    return `<li><div class="history-version"><h3>v${escape(release.tag.slice(9))}</h3><time datetime="${release.date}">${release.date}</time></div><div class="history-downloads">${downloads}<a href="${release.releaseNotes}">更新记录</a></div></li>`;
  }).join('');
  return `<details class="download-history" id="desktop-history"><summary>历史版本 <span>${history.length} 个版本</span></summary><p>按需下载此前发布的 Windows x64 版本。v1.0.6 安装包由官网分发，其余文件从 GitHub 下载。</p><ul>${rows}</ul><p>历史功能与运行内核以各版更新记录为准。安装前请退出正在运行的 Trylo。</p></details>`;
}
