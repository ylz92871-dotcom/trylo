// Test-only red selector: replay the saved pre-fix module at its original URL,
// so its real relative dependencies still load. A loader/import failure is not
// evidence of the experience contract failing.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
const baseline = process.env.TRYLO_HERMES_EXPERIENCE_BASELINE;
if (!baseline) throw new Error('experience baseline path required');
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/skill/experience.ts')) return result;
  return { ...result, source: readFileSync(baseline, 'utf8') };
} });
