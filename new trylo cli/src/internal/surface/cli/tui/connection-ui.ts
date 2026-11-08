import type { CliContext } from "../context.js";
import type { RunCommandOptions } from "../args.js";
import type { TuiIo } from "./io.js";
import { connectionStatus, listConnections } from "../connection-status.js";
import { normalizeChatEndpoint } from "../connection-endpoint.js";
import {
  prepareConnectionDraft,
  type ConnectionCredential,
  type ConnectionDraft,
} from "../connection-draft.js";
import { probeConnection } from "../connection-probe.js";
import { saveConnection, type ConnectionSaveResult } from "../connection-save.js";
import { EXIT_CODES, type ExitCode } from "../../../protocol/cli-stream.js";
import { reviewConnection, type ConnectionFormResult } from "./connection-review.js";
import type { RunFailure, RunScaffold } from "../run-command.js";

type OpenSessionResult =
  | { readonly kind: "opened"; readonly scaffold: RunScaffold }
  | { readonly kind: "failure"; readonly failure: RunFailure };

/**
 * Connection UI for the TUI.
 *
 * The startup page is the first thing a person sees when no provider is ready,
 * and `/connect` is the same form reached from inside a session. Both use the
 * same draft/probe/save pipeline as the non-interactive commands so a connection
 * configured here is configured the same way as one configured from argv.
 */

export type ConnectionStartupResult =
  | { readonly kind: "opened"; readonly scaffold: RunScaffold }
  | { readonly kind: "stop"; readonly exitCode: ExitCode };

export async function runConnectionStartup(
  ctx: CliContext,
  io: TuiIo,
  options: RunCommandOptions,
  open: (options: RunCommandOptions) => Promise<OpenSessionResult>,
): Promise<ConnectionStartupResult> {
  for (;;) {
    const status = connectionStatus(ctx, options);
    if (status.kind === "failed") {
      io.write(`${status.failure.message}\n`);
      io.write(`${status.failure.hint}\n`);
      const choice = await askChoice(io, "[r]etry  [q]uit", ["r", "q"]);
      if (choice === undefined || choice === "q") return { kind: "stop", exitCode: status.failure.exitCode };
      continue;
    }

    if (status.kind === "ready") {
      const opened = await open(options);
      if (opened.kind === "failure") {
        io.write(`${opened.failure.message}\n`);
        io.write(`${opened.failure.hint}\n`);
        const choice = await askChoice(io, "[r]etry  [q]uit", ["r", "q"]);
        if (choice === undefined || choice === "q") return { kind: "stop", exitCode: opened.failure.exitCode };
        continue;
      }

      return { kind: "opened", scaffold: opened.scaffold };
    }

    if (status.kind === "needs_connection") {
      io.write("No provider is configured yet. Add one to use a real model.\n");
      const choice = await askChoice(io, "[a]dd connection  [o]ffline demo (fixture, not a model)  [q]uit", ["a", "o", "q"]);
      if (choice === undefined || choice === "q") return { kind: "stop", exitCode: EXIT_CODES.OK };

      if (choice === "o") {
        const opened = await open({ ...options, provider: "fixture" });
        if (opened.kind === "failure") {
          io.write(`${opened.failure.message}\n`);
          io.write(`${opened.failure.hint}\n`);
          continue;
        }

        io.write("starting offline demo (fixture provider)\n");

        return { kind: "opened", scaffold: opened.scaffold };
      }

      const result = await runConnectForm(ctx, io, "add");
      if (result === undefined) continue;

      if (!result.ok) {
        reportSaveFailure(io, result);
        continue;
      }

      io.write(`saved connection ${result.id}${result.accountId !== undefined ? ` (account ${result.accountId})` : ""}\n`);
      continue;
    }

    // needs_credential
    io.write(`Connection ${status.provider.providerId}/${status.provider.model} is selected, but no credential is ready.\n`);
    const choice = await askChoice(io, "[a]dd or bind credential  [q]uit", ["a", "q"]);
    if (choice === undefined || choice === "q") return { kind: "stop", exitCode: EXIT_CODES.AUTH };

    const providers = listConnections(ctx);
    const existing = providers.ok
      ? providers.providers.find((p) => p.id === status.provider.providerId)
      : undefined;
    const result = await runConnectForm(
      ctx,
      io,
      existing?.id !== undefined && !existing.builtin && existing.kind === "openai-compatible" ? "edit" : "add",
      existing?.id,
    );
    if (result === undefined) continue;

    if (!result.ok) {
      reportSaveFailure(io, result);
      continue;
    }

    io.write(`saved connection ${result.id}${result.accountId !== undefined ? ` (account ${result.accountId})` : ""}\n`);
  }
}

function reportSaveFailure(io: TuiIo, result: Extract<ConnectionSaveResult, { ok: false }>): void {
  io.write(`save failed at stage ${result.stage}: ${result.code}: ${result.detail}\n`);

  if (result.committed.length > 0) {
    io.write(`already committed: ${result.committed.join(", ")}\n`);
  }

  if (result.accountId !== undefined) {
    io.write(`account id: ${result.accountId}\n`);
  }
}

export async function runConnectForm(
  ctx: CliContext,
  io: TuiIo,
  operation: "add" | "edit",
  existingId?: string,
): Promise<ConnectionFormResult | undefined> {
  const providers = listConnections(ctx);
  const existing =
    operation === "edit" && providers.ok
      ? providers.providers.find((p) => p.id === existingId)
      : undefined;

  // A form that starts mid-question leaves the person unsure what they are
  // inside; one line names the operation before the first prompt.
  io.write(`${operation === "edit" ? `edit connection ${existingId ?? "?"}` : "add a connection"}\n`);
  io.write("输入 /cancel 可随时取消；草稿在保存前不会写入配置。\n");

  let id: string | undefined = operation === "edit" ? existingId : undefined;

  if (operation === "add") {
    const displayName = await askLine(io, "display name (used to generate the id)");
    if (displayName === undefined) return undefined;

    const generated = generateId(displayName);

    io.write(`suggested id: ${generated}\n`);
    const confirmed = await askLine(io, "id (press enter to keep the suggestion)");
    if (confirmed === undefined) return undefined;

    id = confirmed.trim().length === 0 ? generated : confirmed.trim();
  }

  if (id === undefined) return undefined;

  const defaultAddress = existing?.endpoint ?? "";
  // The default already renders as `[value]`; repeating it inside the prompt
  // printed the same address twice on an edit.
  let address = await askLine(
    io,
    defaultAddress.length > 0 ? "address" : "address (https://...)",
    defaultAddress,
  );
  if (address === undefined) return undefined;

  const kind = await askChoice(io, "address kind: [b]ase-url  [e]ndpoint", ["b", "e"]);
  if (kind === undefined) return undefined;

  const addressKind: "base-url" | "endpoint" = kind === "b" ? "base-url" : "endpoint";

  let normalized = normalizeChatEndpoint(address, addressKind);

  while (!normalized.ok) {
    io.write(`${normalized.code}: ${normalized.detail}\n`);
    address = await askLine(io, "服务地址（重新填写）", address);
    if (address === undefined) return undefined;
    normalized = normalizeChatEndpoint(address, addressKind);
  }

  const defaultModel = existing?.model ?? "";
  const model = await askLine(io, "model id", defaultModel);
  if (model === undefined) return undefined;

  // "skip" is only true when there is nothing to keep: on an edit, Enter
  // keeps the declared window, and the prompt says which of the two it is.
  const contextDefault = existing?.contextWindow?.toString() ?? "";
  let contextWindowInput = await askLine(
    io,
    contextDefault.length > 0 ? "context window" : "context window (enter to skip)",
    contextDefault,
  );
  if (contextWindowInput === undefined) return undefined;

  let contextWindow = parseOptionalPositiveInt(contextWindowInput);

  while (contextWindowInput.trim().length > 0 && contextWindow === undefined) {
    io.write("context window must be a positive integer\n");
    contextWindowInput = await askLine(io, "上下文窗口（正整数；/cancel 取消）", contextDefault);
    if (contextWindowInput === undefined) return undefined;
    contextWindow = parseOptionalPositiveInt(contextWindowInput);
  }

  const credential = await askCredential(ctx, io, providers.ok ? providers.accounts : []);
  if (credential === undefined) return undefined;

  const draft: ConnectionDraft = {
    operation,
    id,
    address: normalized.endpoint,
    addressKind,
    model: model.trim(),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    credential,
  };

  if (io.choose !== undefined) return reviewConnection(ctx, io, draft);

  const prepared = prepareConnectionDraft(ctx, draft);
  if (!prepared.ok) {
    io.write(`draft invalid: ${prepared.code}: ${prepared.detail}\n`);
    return undefined;
  }

  const probe = await askChoice(io, "verify the connection now? [y]es  [n]o", ["y", "n"]);
  if (probe === undefined) return undefined;

  if (probe === "y") {
    io.write("verifying...\n");
    const result = await probeConnection(ctx, draft);
    if (!result.ok) {
      io.write(`probe failed: ${result.code}: ${result.detail} (${result.durationMs}ms)\n`);
      const saveAnyway = await askChoice(io, "save anyway? [y]es  [n]o", ["y", "n"]);
      if (saveAnyway !== "y") return undefined;
    } else {
      io.write(`probe ok: ${result.endpoint} -> ${result.model} (${result.durationMs}ms)\n`);
    }
  }

  return saveConnection(ctx, draft);
}

async function askCredential(
  ctx: CliContext,
  io: TuiIo,
  accounts: ReadonlyArray<{ readonly accountId: string; readonly label?: string }>,
): Promise<ConnectionCredential | undefined> {
  const kind = await askChoice(io, "credential: [s]ecret  [a]ccount  [e]nvironment", ["s", "a", "e"]);
  if (kind === undefined) return undefined;

  if (kind === "s") {
    const secret = await ctx.readSecret();
    if (secret === undefined) return undefined;
    const label = await askLine(io, "label (optional)");
    if (label === undefined) return undefined;
    return { kind: "secret", secret, ...(label.trim().length === 0 ? {} : { label: label.trim() }) };
  }

  if (kind === "a") {
    if (accounts.length === 0) {
      io.write("no stored accounts; use `trylo login` first or choose a secret\n");
      return undefined;
    }

    accounts.forEach((account, index) => {
      io.write(`${index + 1}. ${account.accountId}${account.label !== undefined ? ` (${account.label})` : ""}\n`);
    });
    const input = await askLine(io, "select account by number or id");
    if (input === undefined) return undefined;

    const account = findAccount(accounts, input);
    if (account === undefined) {
      io.write("account not found\n");
      return undefined;
    }

    return { kind: "account", accountId: account.accountId };
  }

  return { kind: "environment" };
}

function findAccount(
  accounts: ReadonlyArray<{ readonly accountId: string; readonly label?: string }>,
  input: string,
): { readonly accountId: string; readonly label?: string } | undefined {
  const trimmed = input.trim();
  const byIndex = Number(trimmed);
  if (!Number.isNaN(byIndex) && byIndex >= 1 && byIndex <= accounts.length) {
    return accounts[byIndex - 1];
  }
  return accounts.find((account) => account.accountId === trimmed);
}

function generateId(displayName: string): string {
  const ascii = displayName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .toLowerCase();
  const trimmed = ascii.replace(/^-+|-+$/g, "");
  if (trimmed.length === 0) return "connection";

  return trimmed.slice(0, 63);
}

function parseOptionalPositiveInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

async function askLine(io: TuiIo, prompt: string, defaultValue = ""): Promise<string | undefined> {
  io.write(`${prompt}${defaultValue.length > 0 ? ` [${defaultValue}]` : ""}: `);
  const answer = await io.readLine();
  if (answer === undefined) {
    io.write("\n");
    return undefined;
  }

  const trimmed = answer.trim();
  if (trimmed === "/cancel") return undefined;

  return trimmed.length === 0 ? defaultValue : trimmed;
}

async function askChoice(
  io: TuiIo,
  prompt: string,
  valid: ReadonlyArray<string>,
): Promise<string | undefined> {
  for (;;) {
    io.write(`${prompt}: `);
    const answer = await io.readLine();
    if (answer === undefined) {
      io.write("\n");
      return undefined;
    }

    const normalized = answer.trim().toLowerCase();
    if (normalized === "/cancel") return undefined;

    if (normalized.length === 0) continue;

    if (valid.includes(normalized)) return normalized;

    io.write(`choose one of: ${valid.join(", ")}\n`);
  }
}

