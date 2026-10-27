import { desktopReleaseHistory } from './desktop-release-history.mjs';
export function desktopDownloadActions(release){
 const {installer,version,checksumPath,releaseNotes}=release;
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const updates=Array.isArray(release.changes)?release.changes.map(item=>`<li>${escape(item)}</li>`).join(''):'';
 if(!/^\d+\.\d+\.\d+$/.test(version)||!/^\/download\/desktop\/releases\/[\w./-]+$/.test(installer.path)||!/^\/download\/desktop\/releases\/[\w./-]+$/.test(checksumPath)||!/^https:\/\/github\.com\/ylz92871-dotcom\/trylo\/releases\/tag\/[\w.-]+$/.test(releaseNotes))throw Error('Unexpected desktop release URLs');
 return `<a class="primary" href="${installer.path}" download>下载 Windows 安装包<svg viewBox="0 0 20 20"><path d="M4 15 15 4M4 4h11v11"/></svg></a><p class="download-availability">Windows x64 · v${version} 预览版 · ${Math.round(installer.bytes/1048576)} MB<br>未签名版本，安装前请退出 Trylo。</p><div class="download-secondary"><a class="download-contact" href="${releaseNotes}">更新记录</a><a class="download-contact" href="${checksumPath}" download>SHA-256 校验值</a></div>${updates?`<div class="download-release-notes"><h2>v${version} 更新说明</h2><ul>${updates}</ul><p>历史版本保留，可按需回退。</p></div>`:''}${desktopReleaseHistory(release.history)}`;
}
