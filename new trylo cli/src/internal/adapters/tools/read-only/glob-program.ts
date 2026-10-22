/** Thompson-style glob execution: each state is visited once per input code unit. */
export type GlobToken =
  | { readonly kind: "character"; readonly accepts: (char: string) => boolean }
  | { readonly kind: "star"; readonly accepts: (char: string) => boolean }
  | { readonly kind: "alternatives"; readonly branches: ReadonlyArray<ReadonlyArray<GlobToken>> };

type State =
  | { readonly kind: "accept" }
  | { readonly kind: "split"; readonly targets: ReadonlyArray<number> }
  | { readonly kind: "character"; readonly accepts: (char: string) => boolean; readonly next: number };

export function globProgram(tokens: ReadonlyArray<GlobToken>): (text: string) => boolean {
  const states: State[] = [{ kind: "accept" }];
  const add = (state: State): number => { states.push(state); return states.length - 1; };
  function compile(sequence: ReadonlyArray<GlobToken>, terminal: number): number {
    let next = terminal;
    for (let index = sequence.length - 1; index >= 0; index -= 1) {
      const token = sequence[index];
      if (token === undefined) continue;
      if (token.kind === "character") next = add({ ...token, next });
      else if (token.kind === "alternatives") next = add({ kind: "split", targets: token.branches.map(branch => compile(branch, next)) });
      else {
        const split = add({ kind: "split", targets: [] });
        const character = add({ kind: "character", accepts: token.accepts, next: split });
        states[split] = { kind: "split", targets: [next, character] };
        next = split;
      }
    }
    return next;
  }
  const first = compile(tokens, 0);
  function closure(seeds: Iterable<number>): Set<number> {
    const visited = new Set<number>();
    const active = new Set<number>();
    const pending = [...seeds];
    while (pending.length > 0) {
      const at = pending.pop();
      if (at === undefined || visited.has(at)) continue;
      visited.add(at);
      const state = states[at];
      if (state?.kind === "split") pending.push(...state.targets);
      else active.add(at);
    }
    return active;
  }
  const initial = closure([first]);
  return text => {
    let active = initial;
    for (let index = 0; index < text.length; index += 1) {
      const targets = new Set<number>();
      for (const at of active) {
        const state = states[at];
        if (state?.kind === "character" && state.accepts(text.charAt(index))) targets.add(state.next);
      }
      if (targets.size === 0) return false;
      active = closure(targets);
    }
    return active.has(0);
  };
}
