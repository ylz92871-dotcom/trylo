export type ToolAcquireCommand =
  | { readonly kind: "acquire-plan"; readonly requestFile: string }
  | { readonly kind: "acquire"; readonly requestFile: string; readonly approvedPlanId: string };

export function parseToolAcquire(argv: readonly string[]): ToolAcquireCommand | { readonly kind: "error"; readonly message: string } | undefined {
  if (argv[0] !== "acquire-plan" && argv[0] !== "acquire") return undefined;
  const tokens = argv.slice(1).filter(token => token !== "--json");
  const requestFile = tokens[0];
  if (requestFile === undefined || requestFile.trim().length === 0 || requestFile.startsWith("-")) return { kind: "error", message: "acquisition needs a frozen request.json" };
  if (argv[0] === "acquire-plan" && tokens.length === 1) return { kind: "acquire-plan", requestFile };
  if (argv[0] === "acquire" && tokens.length === 3 && tokens[1] === "--approve" && /^npm-quarantine_v1_[a-f0-9]{64}$/.test(tokens[2] ?? "")) return { kind: "acquire", requestFile, approvedPlanId: tokens[2] as string };
  return { kind: "error", message: "review with tools acquire-plan request.json; acquire requires --approve <exact planId>" };
}
