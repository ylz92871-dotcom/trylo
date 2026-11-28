// Compatibility CLI for Windows build callers; verification has one shared owner.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuiltinTools } from '../shared/verify-builtin-tools.mjs';
export { verifyBuiltinTools } from '../shared/verify-builtin-tools.mjs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node verify-builtin-tools.mjs <bundle-root>');
  console.log(JSON.stringify(await verifyBuiltinTools(path.resolve(process.argv[2]))));
}
