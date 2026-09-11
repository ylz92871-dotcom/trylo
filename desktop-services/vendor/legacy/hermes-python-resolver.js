'use strict';

/*
 * hermes-python-resolver.js
 *
 * Locates the official Hermes 0.19.0 Python interpreter without hardcoding a
 * username path. Used by the capability manager and the smoke tests so there
 * is one source of truth for resolution.
 *
 * Resolution order:
 *   1. HERMES_PYTHON env var (explicit override).
 *   2. <uv tool dir>/hermes-agent/{Scripts/python.exe, bin/python}.
 *
 * Throws if nothing is found.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function resolveHermesPython() {
  const override = String(process.env.HERMES_PYTHON || '').trim();
  if (override) return override;

  let toolsDir = '';
  try {
    toolsDir = execFileSync('uv', ['tool', 'dir'], { encoding: 'utf8' }).trim();
  } catch {
    toolsDir = '';
  }
  if (!toolsDir) {
    throw new Error(
      'Could not run `uv tool dir`. Set HERMES_PYTHON to the Hermes 0.19.0 ' +
        'interpreter path (e.g. .../uv/tools/hermes-agent/Scripts/python.exe).',
    );
  }
  const candidates = [
    path.join(toolsDir, 'hermes-agent', 'Scripts', 'python.exe'), // Windows venv
    path.join(toolsDir, 'hermes-agent', 'bin', 'python'), // POSIX venv
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Hermes python not found under ${toolsDir}. Install hermes-agent==0.19.0 ` +
      `with uv, or set HERMES_PYTHON.`,
  );
}

module.exports = { resolveHermesPython };
