/** Structured user input carried by the CLI control protocol and saved messages.
 * These are data contracts; approval and process ownership stay in the runtime. */
export interface InputRequestQuestion {
  readonly multiSelect?: boolean;
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
}

export interface InputRequestAnswer {
  readonly optionLabels?: readonly string[];
  readonly optionLabel?: string;
  readonly otherText?: string;
}
