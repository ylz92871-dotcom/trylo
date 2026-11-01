/** Minimal adapter-only declarations; no upstream classes escape into Trylo contracts. */
declare module "semver" {
  const semver: {
    valid(value: string): string | null;
    validRange(value: string): string | null;
    satisfies(version: string, range: string): boolean;
  };
  export default semver;
}
