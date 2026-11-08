// Local source verification: adjacent generated .js files must not hide current TS.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

registerHooks({ resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith(".") || specifier.startsWith("file:")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(pathToFileURL(fileURLToPath(candidate)).href, context);
  }
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);

  // Node's experimental TS parser rejects this valid default-arrow conditional.
  // Keep the owning source intact and use the installed TS compiler only for
  // this grammar case. This is behavior execution, never a successful type gate.
  if (!url.endsWith("/internal/learning/agent/subsystems/tool/runtime/frozen-use.ts")) return loaded;

  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const transpiled = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true,
  } });

  process.stderr.write("source-loader: official TypeScript grammar fallback for tool/runtime/frozen-use.ts\n");

  return { ...loaded, format: "module", source: transpiled.outputText };
} });
