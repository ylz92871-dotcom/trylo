import { workspacePath } from '../../../../../scripts/workspace-paths.mjs';

/** Development source supply and preview cache; packaged runtime roots are separate. */
export const previewCachePath = (...segments) => workspacePath('cache', 'desktop', 'preview', ...segments);
