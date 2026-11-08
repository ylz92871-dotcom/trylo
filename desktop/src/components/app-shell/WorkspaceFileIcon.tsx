import {
  Archive, File, FileAudio, FileCode2, FileCog, FileText, Film, Image,
  Presentation, Sheet, type LucideIcon,
} from 'lucide-react';

const code = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'cs', 'vue', 'svelte', 'html', 'css', 'scss', 'sql', 'sh', 'ps1']);
const config = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'xml']);

function fileKind(name: string): { Icon: LucideIcon; tone: string } {
  const lower = name.toLowerCase();
  const extension = lower.split('.').at(-1) ?? '';
  if (code.has(extension)) return { Icon: FileCode2, tone: 'code' };
  if (config.has(extension) || lower.startsWith('.')) return { Icon: FileCog, tone: 'config' };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif', 'heic'].includes(extension)) return { Icon: Image, tone: 'media' };
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(extension)) return { Icon: Film, tone: 'media' };
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(extension)) return { Icon: FileAudio, tone: 'media' };
  if (['xlsx', 'xls', 'csv', 'ods'].includes(extension)) return { Icon: Sheet, tone: 'sheet' };
  if (['pptx', 'ppt', 'odp'].includes(extension)) return { Icon: Presentation, tone: 'document' };
  if (['md', 'mdx', 'txt', 'pdf', 'docx', 'doc', 'rtf', 'log'].includes(extension)) return { Icon: FileText, tone: 'document' };
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(extension)) return { Icon: Archive, tone: 'config' };
  return { Icon: File, tone: 'plain' };
}

export function WorkspaceFileIcon({ name }: { readonly name: string }): JSX.Element {
  const { Icon, tone } = fileKind(name);
  return <Icon className={`tree-node__icon tree-node__icon--${tone}`} size={16} strokeWidth={1.5} aria-hidden="true" />;
}
