import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { TRYLO_VERSION } from "../../protocol/version.js";
import type { CliContext } from "./context.js";
import type { UpdateOptions } from "./args-update.js";
import { reportFailure } from "./run-failure.js";

/**
 * `update` handler (WP24.1 / C86).
 *
 * Check-only by construction. The old CLI's updater
 * (`trylo cli/src/utils/autoUpdater.ts`, GCS bucket
 * `claude-code-dist-*`) belongs to that product's release system and was
 * deliberately not carried over: installing those bytes would rebrand this
 * CLI as that product. With no channel configured there is nothing to
 * compare against, so:
 *
 * - `update --check` exits 0 and says exactly that (text and JSON agree);
 * - bare `update` refuses with CONFIG rather than performing a fake
 *   install that leaves the tree unchanged and reports success.
 *
 * Reads nothing but the compiled-in version: no network, no registry, no
 * credential, no filesystem scan — a completion-grade side-effect-free
 * command, which is why the failure vocabulary lives here instead of in a
 * doctor row (doctor's zero-difference gate promises byte-identical
 * output, and a new row would break that promise).
 */

export type UpdateStatus = {
  readonly version: string;
  readonly channel: "not-configured";
  readonly updateAvailable: "unknown";
  readonly detail: string;
};

export function updateStatus(): UpdateStatus {
  return {
    version: TRYLO_VERSION,
    channel: "not-configured",
    updateAvailable: "unknown",
    detail: "no release channel is configured for this CLI; installs come from the checkout it was built from",
  };
}

export function handleUpdate(ctx: CliContext, options: UpdateOptions): ExitCode {
  const status = updateStatus();

  if (options.check) {
    if (options.json) {
      ctx.stdout(`${JSON.stringify({ update: status })}\n`);
      return EXIT_CODES.OK;
    }
    ctx.stdout(`trylo ${status.version}: ${status.detail}\n`);
    return EXIT_CODES.OK;
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ update: status })}\n`);
  }

  return reportFailure(ctx, {
    exitCode: EXIT_CODES.CONFIG,
    message: `cannot install an update: ${status.detail}`,
    hint: "run `trylo update --check` to see the channel status",
  });
}
