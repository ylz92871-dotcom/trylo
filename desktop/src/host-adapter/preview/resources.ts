import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../tauri-detect';
import { decodePreviewText } from '../../preview/decode-text';
export async function readPreviewHead(filePath: string, allowedRoot: string): Promise<Uint8Array> {
  if (isTauri()) return new Uint8Array(await invoke<ArrayBuffer>('preview_head', { filePath, allowedRoot }));
  const response = await fetch('/__dev_preview/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot }) });
  if (!response.ok) throw new Error(await response.text());
  return new Uint8Array(await response.arrayBuffer());
}
export async function readPreviewBinary(filePath: string, allowedRoot?: string): Promise<Uint8Array> {
  const normalized = filePath.replace(/\\/g, '/');
  const parent = normalized.slice(0, normalized.lastIndexOf('/') + 1);
  const root = allowedRoot ?? parent;
  if (!root) throw new Error('预览文件路径不完整，请重新打开文件');
  if (isTauri()) return new Uint8Array(await invoke<ArrayBuffer>('preview_binary', { filePath, allowedRoot: root }));
  const response = await fetch('/__dev_preview/binary', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot: root }),
  });
  if (!response.ok) throw new Error(await response.text());
  return new Uint8Array(await response.arrayBuffer());
}
export async function readPreviewText(filePath: string, allowedRoot: string): Promise<string> {
  if (isTauri()) return decodePreviewText(new Uint8Array(await invoke<ArrayBuffer>('preview_text', { filePath, allowedRoot })));
  const response = await fetch('/__dev_preview/text', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot }),
  });
  if (!response.ok) throw new Error(await response.text());
  return decodePreviewText(new Uint8Array(await response.arrayBuffer()));
}
export async function readPreviewResource(filePath: string, allowedRoot: string): Promise<Uint8Array> {
  if (isTauri()) return new Uint8Array(await invoke<ArrayBuffer>('preview_resource', { filePath, allowedRoot }));
  const response = await fetch('/__dev_preview/resource', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, allowedRoot }),
  });
  if (!response.ok) throw new Error(await response.text());
  return new Uint8Array(await response.arrayBuffer());
}
