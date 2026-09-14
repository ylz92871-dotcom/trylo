// Trylo Desktop — React entry. See ARCHITECTURE.md §3 Phase 0 Day 1.
//
// Day 1 scope: render a recognizable "Hello, Trylo" message to prove the
// Tauri 2 + React 18 + Vite pipeline is alive. No IPC, no editor, no
// HostAdapter wiring — those land in later days.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  // Fail loudly — a missing #root is a build/index.html bug, not a runtime
  // condition we should paper over.
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
