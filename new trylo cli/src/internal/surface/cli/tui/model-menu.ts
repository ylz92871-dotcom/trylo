import type { CliContext } from "../context.js";
import type { TuiIo } from "./io.js";
import { listConnections } from "../connection-status.js";
import { setDefaultConnection, switchRunConnection } from "../connection-switch.js";
import { isRunFailure, type RunFailure, type RunScaffold } from "../run-command.js";
import type { CliSink } from "../render.js";
import { choose } from "./choose.js";

/**
 * Interactive model selection for `/model` without an argument.
 *
 * The menu lists declared providers and their models; an OpenAI-compatible
 * declaration also accepts a hand-typed model id. Choosing "use once" opens a
 * new session with that provider/model, while "set default" persists the choice
 * first and then opens the new session.
 *
 * The two halves of "set default" are reported separately: the write can
 * succeed and the session that follows it can still fail to open, and a person
 * told only "it failed" would redo a default that is already saved.
 */

export async function runModelMenu(
  ctx: CliContext,
  io: TuiIo,
  scaffold: RunScaffold,
  sink: CliSink,
): Promise<RunScaffold | RunFailure | undefined> {
  if (!ctx.stdinIsTty) {
    io.write(`usage: /model <model-id> (current: ${scaffold.model})\n`);
    return undefined;
  }

  const connections = listConnections(ctx);
  if (!connections.ok) {
    io.write(`cannot list connections: ${connections.failure.code}: ${connections.failure.detail}\n`);
    return undefined;
  }

  if (connections.providers.length === 0) {
    io.write("no providers are declared; use `/connect` to add one first\n");
    return undefined;
  }

  const providerInput = await choose(io, {
    title: "选择模型服务 · 开启新会话，原会话可 /resume 返回",
    initialId: scaffold.providerId,
    items: connections.providers.map(provider => ({ id: provider.id, label: provider.id,
      detail: `${provider.id === scaffold.providerId ? "正在使用 · " : ""}${provider.id === connections.selected ? "默认 · " : ""}${provider.model || provider.kind}` })),
  });
  if (providerInput === undefined) return undefined;

  const provider = findProvider(connections.providers, providerInput);
  if (provider === undefined) {
    io.write("provider not found; pick a number or id from the list\n");
    return undefined;
  }

  let model = provider.id === scaffold.providerId && provider.model.length === 0 ? scaffold.model : provider.model;

  if (provider.models.length > 0 || provider.manualModel) {
    if (provider.models.length > 0 && io.choose === undefined) {
      io.write("models:\n");
      provider.models.forEach((model, index) => io.write(`  ${index + 1}. ${model}\n`));
    }

    if (provider.manualModel && io.choose === undefined) {
      io.write("  0. type a model id manually\n");
    }

    // Enter keeps the declared model. An empty answer used to fall through to
    // the manual-id branch and set the model to "", which is not a model id at
    // all; on a provider with no catalogue it is also the only way to say
    // "the declared one is fine".
    const modelInput = io.choose === undefined
      ? await askLine(io, "select model by number or id (enter keeps the declared model)")
      : await choose(io, { title: "选择模型", initialId: scaffold.providerId === provider.id ? scaffold.model : provider.model,
        items: [...[...new Set([provider.id === scaffold.providerId ? scaffold.model : "", provider.model, ...provider.models])].filter(id => id.length > 0).map(id => ({ id, label: id,
          ...(provider.id === scaffold.providerId && id === scaffold.model ? { detail: "正在使用" } : id === provider.model ? { detail: "声明的默认模型" } : {}) })),
          ...(provider.manualModel ? [{ id: "0", label: "手动输入模型 ID" }] : [])] });
    if (modelInput === undefined) return undefined;

    if (modelInput.trim().length === 0) {
      model = provider.model;
    } else if (provider.manualModel && modelInput.trim() === "0") {
      const custom = await askLine(io, "model id");
      if (custom === undefined || custom.length === 0) return undefined;
      model = custom;
    } else {
      const chosen = findModel(provider.models, modelInput);
      if (chosen === undefined) {
        if (provider.manualModel) {
          model = modelInput.trim();
        } else {
          io.write("model not found; pick a number or id from the list\n");
          return undefined;
        }
      } else {
        model = chosen;
      }
    }
  }

  const action = await choose(io, { title: "如何使用此模型？", items: [
    { id: "u", label: "本次使用", detail: "开启新会话，默认设置不变" },
    { id: "d", label: "设为默认并使用", detail: "保存到用户配置并开启新会话" },
  ] });
  if (action === undefined) return undefined;

  if (action === "d") {
    const defaulted = setDefaultConnection(ctx, { providerId: provider.id, model });
    if (!defaulted.ok) {
      io.write(`default failed at stage ${defaulted.stage}: ${defaulted.code}: ${defaulted.detail}\n`);

      // The model write happens before the selection write, so a failure in
      // the selection step leaves the model saved; say so instead of implying
      // nothing was written.
      if (defaulted.stage === "selection") {
        io.write(`  the declared model for ${provider.id} may already be saved as ${model}\n`);
      }

      return undefined;
    }
  }

  const switched = await switchRunConnection(ctx, scaffold, { providerId: provider.id, model }, sink, "interactive");
  if (action === "d" && isRunFailure(switched)) {
    // Opening the new session failed after the default was written. Both facts
    // are stated, so the person does not redo a write that already happened.
    io.write(`default saved: ${provider.id} / ${model}\n`);
  }

  return switched;
}

function findProvider(
  providers: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly model: string; readonly models: ReadonlyArray<string>; readonly manualModel: boolean }>,
  input: string,
): { readonly id: string; readonly kind: string; readonly model: string; readonly models: ReadonlyArray<string>; readonly manualModel: boolean } | undefined {
  const trimmed = input.trim();
  const byIndex = Number(trimmed);
  if (!Number.isNaN(byIndex) && byIndex >= 1 && byIndex <= providers.length) {
    return providers[byIndex - 1];
  }
  return providers.find((p) => p.id === trimmed);
}

function findModel(models: ReadonlyArray<string>, input: string): string | undefined {
  const trimmed = input.trim();
  const byIndex = Number(trimmed);
  if (!Number.isNaN(byIndex) && byIndex >= 1 && byIndex <= models.length) {
    return models[byIndex - 1];
  }
  return models.find((m) => m === trimmed);
}

async function askLine(io: TuiIo, prompt: string): Promise<string | undefined> {
  io.write(`${prompt}: `);
  const answer = await io.readLine();
  if (answer === undefined) {
    io.write("\n");
    return undefined;
  }

  return answer.trim() === "/cancel" ? undefined : answer.trim();
}
