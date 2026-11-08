import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// v1.16.0: switch from @vitejs/plugin-react to plugin-react-swc
// (SWC). The Babel-based plugin adds an HMR preamble that it
// can't detect in vitest mode, so any .test.tsx file that
// imports a .tsx component throws "can't detect preamble".
// The SWC variant has no such check.
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { devFileApi } from './vite-plugins/dev-file-api';
import { pdfAssets } from './vite-plugins/preview/pdf-assets';
import { officePreview } from './vite-plugins/preview/office';
import { previewResources } from './vite-plugins/preview/resources';
import { previewFormatAssets } from './vite-plugins/preview/format-assets';

// Vite config for Trylo Desktop (Tauri 2 + React + Monaco).
// See docs/ARCHITECTURE.md for the architecture.

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Tests must not replace optimization metadata used by an open Desktop window.
  cacheDir: fileURLToPath(new URL(
    process.env.VITEST === 'true' ? './node_modules/.vite-test' : './node_modules/.vite-desktop',
    import.meta.url,
  )),
  // Readers import Monaco lazily; prepare it before serving an open conversation.
  optimizeDeps: { include: ['monaco-editor'] },
  // nodePolyfills: the Gerber stack (gerber-parser) needs Node's
  // string_decoder/Buffer shims in the webview. Scoped here so the
  // shims ride the lazy preview chunk, not every module.
  // NOT loaded under vitest: the test runner is real Node and needs
  // the genuine `node:fs` (shimming it breaks fs-based tests).
  plugins: [
    react(),
    ...(process.env.VITEST === 'true' ? [] : [nodePolyfills()]),
    devFileApi(),
    pdfAssets(),
    officePreview(),
    previewResources(),
    previewFormatAssets(),
  ],

  resolve: {
    alias: {
      // Keep one React runtime across renderer and lazy preview modules.
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
      'react/jsx-runtime': fileURLToPath(
        new URL('./node_modules/react/jsx-runtime', import.meta.url),
      ),
      'lucide-react': fileURLToPath(
        new URL('./node_modules/lucide-react', import.meta.url),
      ),
    },
  },

  // Tauri expects a fixed port. Fail if it's not available.
  clearScreen: false,
  server: {
    fs: { allow: [fileURLToPath(new URL('../', import.meta.url))] },
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tauri controls the Rust side; don't watch those.
      ignored: ['**/src-tauri/**', '**/target/**', '**/.cache/preview/**'],
    },
  },

  // Vite options for building the production bundle.
  build: {
    target: 'es2022',
    minify: 'esbuild',
    // Release maps duplicate large editor sources and increase peak build
    // memory. Enable them explicitly for diagnosis; development stays mapped.
    sourcemap: process.env.TRYLO_BUILD_SOURCEMAPS === '1',
    // P2 (§7): record the performance budget. Monaco alone is ~3.3 MB,
    // the main entry is ~800 KB — both are accepted for the v1 product
    // (no code-splitting gain from splitting the main entry further).
    chunkSizeWarningLimit: 3500,
    // Monaco bundles a few workers; let Vite know.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        computerPreview: fileURLToPath(new URL('./computer-preview.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          // Monaco + monaco-vscode-api is large; split it out for caching.
          monaco: ['monaco-editor', '@codingame/monaco-vscode-api'],
          // Preview vendors load lazily (React.lazy in PreviewRouter)
          // but still deserve their own cacheable chunks: pdf.js, the
          // Office renderers, and the CAD viewers.
          preview_pdf: ['pdfjs-dist'],
          preview_office: ['docx-preview', 'xlsx', 'pptxviewjs', 'jszip'],
          preview_cad: ['three', 'dxf-parser', 'gerber-to-svg'],
        },
      },
    },
  },

  // Use the Vite-friendly env-prefix.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  // Vitest configuration. We use jsdom so React Testing
  // Library can renderHook + act in the test env. Tauri APIs
  // are not available; tests that need them mock @tauri-apps/api.
  test: {
    // Native node:test probes run separately against real Windows processes.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**/*.platform.test.mjs', 'scripts/ensure-dev-cli.test.mjs', 'scripts/stage-npm.test.mjs'],
    environment: 'jsdom',
    globals: true,
    // Stub the heavy monaco-editor package at test time so tests
    // that touch the dynamic import (e.g. GitDiffView) don't have
    // to ship a 50MB editor into the test runner. The component
    // tolerates a no-op monaco surface — the monaco container is
    // rendered empty, which is what the tests assert on anyway.
    alias: {
      'monaco-editor': fileURLToPath(
        new URL('./src/components/code-surface/__mocks__/monaco-stub.ts', import.meta.url),
      ),
    },
  },
});
