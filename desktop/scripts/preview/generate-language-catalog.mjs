// Extract metadata from the already installed Monaco sources, without executing
// browser code. Runtime format discovery stays pure and shared with Work.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const packageFile = require.resolve('monaco-editor/package.json');
const provider = JSON.parse(await readFile(packageFile, 'utf8'));
const source = path.join(path.dirname(packageFile), 'esm/vs');
const records = new Map();
async function visitDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { await visitDirectory(target); continue; }
    if (!entry.name.endsWith('.contribution.js')) continue;
    const ast = ts.createSourceFile(target, await readFile(target, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if (ts.isCallExpression(node) && /(?:^|\.)register(?:Language)?$/.test(node.expression.getText(ast))) {
        const object = node.arguments[0];
        if (object && ts.isObjectLiteralExpression(object)) {
          const properties = Object.fromEntries(object.properties.filter(ts.isPropertyAssignment).map((property) => [property.name.getText(ast).replaceAll('"', ''), property.initializer]));
          const string = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
          const array = (node) => node && ts.isArrayLiteralExpression(node) ? node.elements.map(string).filter(Boolean) : [];
          const id = string(properties.id);
          if (id && (properties.extensions || properties.aliases)) {
            const next = { id, label: array(properties.aliases)[0] ?? id, extensions: array(properties.extensions), filenames: array(properties.filenames), firstLine: string(properties.firstLine) };
            const prior = records.get(id);
            if (prior) { next.extensions = [...new Set([...prior.extensions, ...next.extensions])]; next.filenames = [...new Set([...prior.filenames, ...next.filenames])]; next.firstLine ??= prior.firstLine; }
            records.set(id, next);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
await visitDirectory(path.join(source, 'basic-languages'));
await visitDirectory(path.join(source, 'language'));
if (records.size < 70) throw new Error('Language extraction lost the installed provider inventory');
const output = fileURLToPath(new URL('../../src/preview/languages.generated.json', import.meta.url));
const content = JSON.stringify({ provider: 'monaco-editor', version: provider.version, languages: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) throw new Error('Regenerate preview language catalog for the installed Monaco version');
} else await writeFile(output, content);
console.log(`Preview language catalog: ${records.size} languages from Monaco ${provider.version}`);
