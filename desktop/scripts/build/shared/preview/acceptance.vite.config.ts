import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../../../../vite.config';
import { artifactPath } from '../../../../../scripts/workspace-paths.mjs';

// Explicit native acceptance build; the test harness is never included in
// the product's ordinary Vite build or installer.
export default defineConfig({
  ...base,
  build: {
    ...base.build,
    outDir: artifactPath('desktop-preview-acceptance'),
    rollupOptions: {
      ...base.build?.rollupOptions,
      input: fileURLToPath(new URL('../../../../testdata/preview-acceptance/index.html', import.meta.url)),
    },
  },
});
