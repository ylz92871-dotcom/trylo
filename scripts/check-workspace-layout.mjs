import { readFileSync } from 'node:fs';
import { repositoryRoot } from './workspace-paths.mjs';
import { inspectWorkspaceLayout } from './workspace-layout.mjs';

const pending = JSON.parse(readFileSync(new URL('./workspace-layout-pending.json', import.meta.url), 'utf8'));
const result = inspectWorkspaceLayout(repositoryRoot, pending);
for (const item of result.violations) console.error(`LAYOUT FAIL ${item.path}: ${item.reason}`);
for (const item of result.pending) console.warn(`LAYOUT PENDING ${item.path}: ${item.reason} (${item.evidence})`);
if (result.clean) console.log('LAYOUT PASS: core projects and engineering infrastructure only; byproducts belong in _workspace.');
else if (!result.violations.length) console.warn(`LAYOUT: no new violations; ${result.pending.length} existing moves remain pending.`);
if (result.violations.length || (process.argv.includes('--strict') && result.pending.length)) process.exitCode = 1;
