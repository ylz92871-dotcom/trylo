import { File, ArrowUpRight } from 'lucide-react';
import type { ReactElement } from 'react';
export interface PreviewFile { readonly path: string; readonly name?: string }
/** Visible even when the detailed result log is collapsed. */
export function ArtifactPreviewStrip({ files, onOpen }: { files: readonly PreviewFile[]; onOpen: (path: string) => void }): ReactElement | null {
  if (!files.length) return null;
  return <div className="artifact-preview-strip" aria-label="成果预览">
    {files.slice(0, 5).map((file) => <button type="button" key={file.path} className="artifact-preview-strip__file" onClick={() => onOpen(file.path)} title={`预览 ${file.path}`}>
      <File size={18} aria-hidden="true" /><span>{file.name ?? file.path.replace(/\\/g, '/').split('/').at(-1)}</span><ArrowUpRight size={14} aria-hidden="true" />
    </button>)}
    {files.length > 5 && <select className="artifact-preview-strip__more" aria-label="更多成果文件" value="" onChange={(event) => onOpen(event.target.value)}>
      <option value="" disabled>其余 {files.length - 5} 个文件</option>
      {files.slice(5).map((file) => <option key={file.path} value={file.path}>{file.name ?? file.path.replace(/\\/g, '/').split('/').at(-1)}</option>)}
    </select>}
  </div>;
}
