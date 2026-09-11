// Trylo Desktop — SearchService impl backed by Tauri IPC. See
// host-adapter/editor-bridge.ts and §2.4 of the architecture doc.

import { invoke } from '@tauri-apps/api/core';
import type { SearchMatch, SearchService } from './search-service';

export const tauriSearchService: SearchService = {
  search: (query, path, options) =>
    invoke<readonly SearchMatch[]>('search', {
      query,
      path,
      regex: options.regex,
      caseInsensitive: options.caseInsensitive,
    }),
};
