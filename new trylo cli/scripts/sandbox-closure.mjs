// Ship the actual Windows execution dependency closure rather than the upstream CLI.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export function copyWindowsClosure(source, destination) {
  const pending = ["dist/sandbox/windows-sandbox-utils.js"];
  const copied = new Set();

  while (pending.length > 0) {
    const path = pending.pop();
    if (copied.has(path)) continue;

    copied.add(path);
    const input = join(source, path);
    const output = join(destination, path);

    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
    const module = ts.createSourceFile(input, readFileSync(input, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    for (const node of module.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;

      if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue;

      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;

      const dependency = relative(source, resolve(dirname(input), specifier));
      if (dependency.startsWith("..")) throw new Error("sandbox closure escapes its source root");

      pending.push(dependency);
    }
  }

  for (const path of ["LICENSE", "PROVENANCE.json", "PATCHES.md"]) {
    mkdirSync(destination, { recursive: true });
    copyFileSync(join(source, path), join(destination, path));
  }

  return copied.size;
}
