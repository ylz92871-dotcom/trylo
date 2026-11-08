import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { observeRunCancellation } from "./run-interrupt.js";
import type { SkillLearningCommandPort, SkillLearningCommandError } from "./skill-learning-command-contract.js";
import type { PermissionChoice } from "./permission-plan.js";
import type { ShellIsolation } from "../../ports/isolation.js";

export const SKILL_LEARNING_USAGE = "trylo skills list | show <version> | withdraw <version> [--json]\nThese commands inspect the legacy Board skill archive. Learning moved to: trylo learn skill --tokens N --calls N.";

type Command = { readonly kind: "list" } | { readonly kind: "show"; readonly versionId: string } | { readonly kind: "withdraw"; readonly versionId: string }
  | { readonly kind: "learn"; readonly maxTokens: number; readonly maxCalls: number; readonly permissionChoice?: PermissionChoice; readonly shellIsolation?: ShellIsolation }
  | { readonly kind: "help" } | { readonly kind: "error"; readonly message: string };

export function parseSkillLearningCommand(argv: readonly string[]): Command {
  const isolationIndex = argv.indexOf("--shell-isolation");
  let shellIsolation: ShellIsolation | undefined;

  if (isolationIndex >= 0) {
    const value = argv[isolationIndex + 1];
    if (isolationIndex !== argv.lastIndexOf("--shell-isolation") || (value !== "sandbox" && value !== "host")) return { kind: "error", message: "shell isolation must be one explicit sandbox or host choice" };
    shellIsolation = value;
  }

  const input = isolationIndex < 0 ? argv : argv.filter((_, index) => index !== isolationIndex && index !== isolationIndex + 1);
  const permissionFlags: readonly string[] = input.filter(item => item === "--allow-writes" || item === "--allow-exec" || item === "--allow-skill-trial");
  const args = input.filter(item => item !== "--json" && !permissionFlags.includes(item)), verb = args[0];
  if (shellIsolation !== undefined && verb !== "learn") return { kind: "error", message: "shell isolation applies only to an explicit learn command" };

  if (permissionFlags.length > 0 && (verb !== "learn" || new Set(permissionFlags).size !== permissionFlags.length)) return { kind: "error", message: "trial permissions apply only to one explicit learn command" };

  if (verb === undefined || verb === "--help" || verb === "help") return { kind: "help" };

  if (verb === "list" && args.length === 1) return { kind: "list" };

  if ((verb === "show" || verb === "withdraw") && args.length === 2 && args[1]?.trim() && !args[1].startsWith("--")) {
    return { kind: verb, versionId: args[1] };
  }

  if (verb === "learn" && args.length === 5) {
    const flags = new Map<string, number>();

    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index], text = args[index + 1];
      if (flag === undefined || (flag !== "--max-tokens" && flag !== "--max-calls") || flags.has(flag)
        || text === undefined || !/^\d+$/.test(text)) return { kind: "error", message: "learning requires unique integer token and call allowances" };
      flags.set(flag, Number(text));
    }

    const maxTokens = flags.get("--max-tokens"), maxCalls = flags.get("--max-calls");
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 100_000
      && maxCalls !== undefined && Number.isSafeInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 16) return { kind: "learn", maxTokens, maxCalls,
        ...(shellIsolation === undefined ? {} : { shellIsolation }),
        ...(permissionFlags.length === 0 ? {} : { permissionChoice: { ...(permissionFlags.includes("--allow-writes") ? { allowWrites: true } : {}),
          ...(permissionFlags.includes("--allow-exec") || permissionFlags.includes("--allow-skill-trial") ? { allowTools: [
            ...(permissionFlags.includes("--allow-exec") ? ["run_shell"] : []), ...(permissionFlags.includes("--allow-skill-trial") ? ["skill"] : [])] } : {}) } }) };
  }

  return { kind: "error", message: SKILL_LEARNING_USAGE };
}

export async function handleSkillLearning(ctx: CliContext, argv: readonly string[], injected?: SkillLearningCommandPort): Promise<ExitCode> {
  const command = parseSkillLearningCommand(argv);

  if (argv[0] === "learn" && injected === undefined) {
    const destination = command.kind === "learn"
      ? `trylo learn skill --tokens ${command.maxTokens} --calls ${command.maxCalls}`
      : "trylo learn skill --tokens N --calls N";
    ctx.stdout(`${JSON.stringify(failure("route_replaced", `此旧学习路由已停接。请使用 ${destination}。`))}\n`);
    return EXIT_CODES.CONFIG;
  }

  if (command.kind === "help") {
    ctx.stdout(`${SKILL_LEARNING_USAGE}\n`);
    return EXIT_CODES.OK;
  }

  if (command.kind === "error") {
    ctx.stdout(`${JSON.stringify(failure("invalid_arguments", command.message))}\n`);
    return EXIT_CODES.USAGE;
  }

  const cancellation = observeRunCancellation(ctx);

  try {
    const active = injected ?? await import("./skill-daily-management.js").then(module => module.createSkillDailyManagement(ctx));
    if (active === undefined) throw new Error("skill_archive_unavailable");

    const result = command.kind === "list" ? await active.list() : command.kind === "show" ? await active.show(command.versionId)
      : command.kind === "withdraw" ? await active.withdraw(command.versionId)
      // The default learn route returned above; only an injected compatibility port reaches this branch.
      : await injected!.learn({ maxTokens: command.maxTokens, maxCalls: command.maxCalls }, cancellation.signal);

    ctx.stdout(`${JSON.stringify(result)}\n`);

    return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  } catch {
    // Domain/provider details remain in owned diagnostics; never print raw credentials or model input.
    ctx.stdout(`${JSON.stringify(failure(cancellation.signal.aborted ? "cancelled" : "skill_management_unavailable", "技能学习服务暂不可用，请稍后重试。"))}\n`);
    return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  } finally {
    cancellation.close();
    try { await injected?.close?.(); }
    catch {
      // The command receipt is already emitted. A lock cleanup fault cannot
      // change whether a committed mutation happened; report it separately.
      ctx.stderr("skill_management_cleanup_failed: 请核对技能服务锁状态。\n");
    }
  }
}

function failure(code: string, message: string): SkillLearningCommandError { return { schemaVersion: 1, ok: false, code, message }; }
