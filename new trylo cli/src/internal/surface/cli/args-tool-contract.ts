export type ToolContractCommand =
  | { readonly kind: "contract-propose"; readonly proposalFile: string }
  | { readonly kind: "contract-show"; readonly proposalId: string }
  | { readonly kind: "contract-approve"; readonly proposalId: string; readonly reviewId: string }
  | { readonly kind: "contract-withdraw"; readonly proposalId: string; readonly reviewId: string }
  | { readonly kind: "contract-revisions"; readonly parentVersionId: string };

export function isToolContractCommand(command: { readonly kind: string }): command is ToolContractCommand {
  return ["contract-propose", "contract-show", "contract-approve", "contract-withdraw", "contract-revisions"].includes(command.kind);
}

/** Exact approval IDs are mandatory; a bare command or source label cannot approve. */
export function parseToolContract(argv: readonly string[]): ToolContractCommand | { readonly kind: "error"; readonly message: string } | undefined {
  const kind = argv[0];
  if (kind === undefined || !kind.startsWith("contract-")) return undefined;

  const tokens = argv.slice(1).filter(token => token !== "--json");
  const argument = (value: string | undefined): value is string => value !== undefined && value.trim().length > 0 && value.length <= 512 && !value.startsWith("-");
  if (kind === "contract-propose" && tokens.length === 1 && argument(tokens[0])) return { kind, proposalFile: tokens[0] };

  if (kind === "contract-show" && tokens.length === 1 && argument(tokens[0])) return { kind, proposalId: tokens[0] };

  if (kind === "contract-revisions" && tokens.length === 1 && argument(tokens[0])) return { kind, parentVersionId: tokens[0] };

  if ((kind === "contract-approve" || kind === "contract-withdraw") && tokens.length === 3 && argument(tokens[0]) && tokens[1] === "--approve" && argument(tokens[2])) {
    return { kind, proposalId: tokens[0], reviewId: tokens[2] };
  }

  return { kind: "error", message: "contract-propose needs proposal.json; contract-show needs proposalId; contract-approve/withdraw need proposalId --approve their exact reviewId; contract-revisions needs parentVersionId" };
}
