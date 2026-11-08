import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";

export type LibraryCommandOptions = { readonly library: "tool" | "expert"; readonly workspace?: string; readonly permissionPromptTool?: "stdio" };

const HINT = "try `trylo library tool|expert --workspace ROOT -` with the ordinary command JSON on stdin";

export function parseLibrary(argv: readonly string[]): ParsedCommand {
  if (argv.includes("--help") || argv.includes("-h")) return familyHelpCommand("library");

  const library = argv[0];
  if (library !== "tool" && library !== "expert") return usageError("library requires tool or expert", HINT);

  let workspace: string | undefined, stdin = false, permissionPromptTool: "stdio" | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "-" && !stdin) {
      stdin = true;
      continue;
    }

    if (flag === "--permission-prompt-tool" && permissionPromptTool === undefined && argv[++index] === "stdio") {
      permissionPromptTool = "stdio";
      continue;
    }

    if (flag === "--workspace" && workspace === undefined) {
      const next = argv[++index];
      if (next?.trim() && next.length <= 4096 && !next.startsWith("--") && !/[\u0000-\u001f]/u.test(next)) {
        workspace = next;
        continue;
      }
    }

    return usageError("invalid or duplicate library transport option", HINT);
  }

  if (!stdin) return usageError("library command requires stdin '-'", HINT);

  return { kind: "library", options: { library, ...(workspace === undefined ? {} : { workspace }),
    ...(permissionPromptTool === undefined ? {} : { permissionPromptTool }) } };
}
