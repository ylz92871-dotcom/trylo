// Trylo Desktop — JS wrapper for the official Tauri
// `tauri-plugin-dialog` file picker. v1.16.2.
//
// Same pattern as pick-folder.ts: real native picker
// when in Tauri, `window.prompt` fallback for browser
// dev (pnpm dev). Supports multiple selection + file
// type filters for the attachment flow.
//
// Returns absolute paths only — the desktop does NOT
// copy files into a hidden directory. The file picker
// is opened with `defaultPath` set to the current
// workspace so users land in their project.
//
// Usage from anywhere: `await pickFiles()` — returns
// the selected file paths (or empty array on cancel).

import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri-detect';

export interface PickFilesResult {
  /** Absolute paths of the selected files. Empty if
   *  the user cancelled. */
  readonly paths: readonly string[];
  /** Which backend produced the result. */
  readonly source: 'plugin-dialog' | 'prompt';
}

/** Tauri file-picker filter — matches the
 *  attachment-utils MIME maps. v1.16.2.6: expanded image
 *  filter so phone photos (heic/heif), scans (tiff), and
 *  vector assets (svg) are all selectable. The 'All files'
 *  fallback lets the user pick anything that exists on
 *  disk; the attachment kind classifier is the final
 *  arbiter. */
const ATTACHMENT_FILTERS = [
  {
    name: 'Office docs',
    extensions: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf'],
  },
  {
    name: 'Images',
    extensions: [
      'png', 'jpg', 'jpeg', 'webp', 'gif',
      'bmp', 'tiff', 'tif', 'heic', 'heif',
      'svg', 'avif', 'ico',
    ],
  },
  { name: 'All files', extensions: ['*'] },
];

export interface PickFilesOptions {
  /** Open the picker at this directory. Defaults to
   *  the process cwd in Tauri / `undefined` in the
   *  browser fallback. */
  readonly defaultPath?: string;
}

export async function pickFiles(
  options: PickFilesOptions = {},
): Promise<PickFilesResult> {
  if (!isTauri()) {
    const line = window.prompt(
      'Attach file paths (paste one or more absolute paths, comma-separated; Tauri not available, using browser fallback):',
    );
    if (!line) return { paths: [], source: 'prompt' };
    const paths = line
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { paths, source: 'prompt' };
  }
  const selected = await open({
    directory: false,
    multiple: true,
    title: 'Attach files',
    filters: ATTACHMENT_FILTERS,
    defaultPath: options.defaultPath,
  });
  if (selected === null) return { paths: [], source: 'plugin-dialog' };
  const paths = Array.isArray(selected) ? selected : [selected];
  return { paths, source: 'plugin-dialog' };
}
