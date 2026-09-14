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

// Vite config for Trylo Desktop (Tauri 2 + React + Monaco).
// See docs/ARCHITECTURE.md for the architecture.

const host = process.env.TAURI_DEV_HOST;

// Work sub-app lives at ../work/src (sibling package, see
// ../../work/README.md). Aliasing lets App.tsx import the
// Work components as `@trylo/work/...` without a separate
// build step. Vite re-uses the desktop's React and lucide-react
// from node_modules.
const workSrc = fileURLToPath(new URL('../work/src', import.meta.url));

export default defineConfig({
  // nodePolyfills: the Gerber stack (gerber-parser) needs Node's
  // string_decoder/Buffer shims in the webview. Scoped here so the
  // shims ride the lazy preview chunk, not every module.
  // NOT loaded under vitest: the test runner is real Node and needs
  // the genuine `node:fs` (shimming it breaks fs-based tests).
  plugins: [
    react(),
    ...(process.env.VITEST === 'true' ? [] : [nodePolyfills()]),
    devFileApi(),
  ],

  resolve: {
    alias: {
      '@trylo/work': fileURLToPath(new URL('../work/src/renderer/index.ts', import.meta.url)),
      '@trylo/work/': workSrc + '/',
      // The work sub-app's React/lucide imports resolve to
      // the desktop's installed packages. We don't run
      // `pnpm install` in work/ (kept light), so the runtime
      // would otherwise 404 on these. Same path mapping as
      // tsconfig.json.
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
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },

  // Vite options for building the production bundle.
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: true,
    // P2 (§7): record the performance budget. Monaco alone is ~3.3 MB,
    // the main entry is ~800 KB — both are accepted for the v1 product
    // (no code-splitting gain from splitting the main entry further).
    chunkSizeWarningLimit: 3500,
    // Monaco bundles a few workers; let Vite know.
    rollupOptions: {
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
