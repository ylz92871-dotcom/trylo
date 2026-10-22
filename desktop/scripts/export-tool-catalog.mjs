// Browser-safe catalogue data. Runtime health still comes exclusively from tooling.health.
import fs from 'node:fs';
import { createToolCatalog } from '../../desktop-services/src/tooling/tool-catalog.mjs';
import { TOOL_PROFILES } from '../../desktop-services/src/tooling/tool-profile-service.mjs';
const catalog = createToolCatalog();
if (catalog.rejected().length) throw new Error(JSON.stringify(catalog.rejected()));
const data = {
  packages: catalog.list().map(manifest => ({
    id: manifest.id, displayName: manifest.displayName, version: manifest.version,
    expectedTools: manifest.mcp.expectedTools,
  })),
  profiles: Object.fromEntries(Object.values(TOOL_PROFILES).map(profile => [profile.id, profile.packageIds])),
};
const output = new URL('../src/tooling/tool-catalog.generated.json', import.meta.url);
const text = JSON.stringify(data, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== text) throw new Error('Tool catalogue changed. Run node scripts/export-tool-catalog.mjs.');
} else fs.writeFileSync(output, text);
