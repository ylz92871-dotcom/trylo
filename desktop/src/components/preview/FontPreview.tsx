import { useEffect, useState, type ReactElement } from 'react';
import { usePreviewBytes } from './usePreviewBytes';
import { PreviewFailure } from './PreviewFailure';
let nextFont = 0;
export function FontPreview({ path, allowedRoot }: { path: string; allowedRoot?: string }): ReactElement {
  const bytes = usePreviewBytes(path, undefined, allowedRoot);
  const [font, setFont] = useState({ name: '', error: '' });
  const [size, setSize] = useState(48); const [sample, setSample] = useState('Try your dream.\nTry your best.\n让想法成为现实。');
  useEffect(() => {
    setFont({ name: '', error: '' });
    if (bytes.status !== 'ready') return;
    if (bytes.bytes.length > 20 * 1024 * 1024) { setFont({ name: '', error: '此字体超过 20 MB 预览限制，请使用外部应用' }); return; }
    if (typeof FontFace === 'undefined' || !document.fonts) { setFont({ name: '', error: '当前系统的字体预览接口不可用' }); return; }
    let stale = false; const name = `TryloPreviewFont${++nextFont}`;
    const face = new FontFace(name, bytes.bytes.slice().buffer as ArrayBuffer);
    void face.load().then(() => { if (!stale) { document.fonts.add(face); setFont({ name, error: '' }); } }, () => { if (!stale) setFont({ name: '', error: '字体无法解码，文件可能损坏或使用不支持的字体格式' }); });
    return () => { stale = true; document.fonts.delete(face); };
  }, [bytes]);
  if (bytes.status === 'error') return <PreviewFailure error={bytes.message} />;
  if (font.error) return <PreviewFailure error={font.error} />;
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="字体阅读工具"><label>字号 <input type="range" min={12} max={128} value={size} aria-label="预览字号" onChange={(event) => setSize(Number(event.target.value))} /></label><span>{size} px</span></div>
    {bytes.status !== 'ready' || !font.name ? <p role="status" className="preview__reader-notice">正在读取字体…</p> : <div className="preview__font" style={{ fontFamily: `"${font.name}", sans-serif` }}>
      <textarea aria-label="字体预览文本" maxLength={2000} value={sample} onChange={(event) => setSample(event.target.value)} style={{ fontFamily: 'inherit', fontSize: size }} />
      <p className="preview__font-alphabet">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 · !?@#$%&amp;()[]</p>
    </div>}
  </div>;
}
