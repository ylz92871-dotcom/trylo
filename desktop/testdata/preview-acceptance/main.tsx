import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FilePeek } from '../../src/components/app-shell/FilePeek';
import { previewKindFor, previewKindNeedsBytes } from '../../src/components/preview/previewKind';
import '../../src/styles/tokens.css';
import '../../src/styles/components/preview.css';
import '../../src/styles/components/file-peek.css';
import '../../src/styles/components/result-dock.css';
import '../../src/styles/components/disclosure.css';
import { ResultDock } from '../../src/components/chat/ResultDock';
import { ArtifactPreviewStrip } from '../../src/components/chat/ArtifactPreviewStrip';
import { readPreviewText } from '../../src/host-adapter/preview/resources';

const root = 'D:/CC/trylo/work/desktop-delivery-preview-20261103/fixtures';
const files = ['document.pdf', 'report.docx', 'workbook.xlsx', 'presentation.pptx', 'chart.png', 'webpage.html', 'interactive-site/index.html', 'model.gltf', 'textured.obj', 'external-resources.glb', 'cube.stp', 'multipage-image.tiff', 'example.heic', 'large-table.csv', 'long-text.txt', 'legacy-gbk.csv', 'readme-preview.md', 'media-preview-v1.mp4', 'encrypted.pdf', 'broken.pdf', 'missing.xlsx'];
function App() {
  const [file, setFile] = useState(files[0]!);
  const [state, setState] = useState({ content: '', loading: true, error: '' });
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stale = false;
    setState({ content: '', loading: !previewKindNeedsBytes(previewKindFor(file)), error: '' });
    if (!previewKindNeedsBytes(previewKindFor(file))) void readPreviewText(`${root}/${file}`, root).then(
      (content) => { if (!stale) setState({ content, loading: false, error: '' }); },
      (error) => { if (!stale) setState({ content: '', loading: false, error: String(error) }); },
    );
    return () => { stale = true; };
  }, [file, revision]);
  return <main style={{ height: '100vh', display: 'flex', background: 'var(--ink-base)', color: 'var(--fg)', fontFamily: 'var(--font-sans)', overflow: 'hidden' }}>
    <section style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', padding: 24 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 20px' }}>文件预览验收</h2>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7 }}>这些入口加载真实文件，直接使用正式 FilePeek 和格式渲染器。当前页面用于验收，不是主界面改版。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{files.map((name) => <button key={name} type="button" onClick={() => setFile(name)}>{name}</button>)}</div>
      <div style={{ marginTop: 'auto' }}><ResultDock id="acceptance-results" mode="work" title="交付物" count={5} status="ready" open={open} onOpenChange={setOpen}
        preview={<ArtifactPreviewStrip files={files.map((name) => ({ path: name, name }))} onOpen={setFile} />}><p>真实文件的验收入口</p></ResultDock></div>
    </section>
    <FilePeek key={file} path={`${root}/${file}`} {...state} allowedRoot={root} files={files.map((name) => ({ path: `${root}/${name}`, name }))} onSelectFile={(path) => setFile(path.replace(`${root}/`, ''))} width={Math.max(360, window.innerWidth * .62)} expanded={expanded} onToggleExpanded={() => setExpanded(!expanded)} onReload={() => setRevision(revision + 1)} onClose={() => setFile('document.pdf')} />
  </main>;
}
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'dark';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
