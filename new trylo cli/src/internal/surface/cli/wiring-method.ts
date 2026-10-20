import path from "node:path";
import { wireMethodLearning } from "../../integration/method/wiring.js";
import { methodSwitchFor } from "../../integration/user-learning/index.js";
import type { LoopPorts } from "../../loop/runner.js";
import type { MethodLearningInput } from "./wiring-optins.js";
import { tryloHome } from "./session-paths.js";

/**
 * The board, or nothing.
 *
 * The path is built here because this is the file that owns the composition
 * root, and it borrows `tryloHome` instead of spelling out the home directory:
 * a second copy of that formula would be right until the day `TRYLO_HOME` is
 * set, and then only one of the two homes would move.
 *
 * `now` is derived from the same injected clock as the compaction stamp, so a
 * test that pins the clock pins the board's timestamps too.
 *
 * The switch is a **total** one now (`method` / `user` / `all`), and the method
 * half is asked first: `methodSwitchFor` turns "either of the two values that
 * enable me" into the single word `wireMethodLearning` accepts. That word is
 * imported from the module that owns it, not restated here — and a switch that
 * does not enable the method half returns `undefined` *before* the board is
 * built, so `--learning=user` never creates a board directory.
 */
export function methodPortOf(input: { readonly learning?: MethodLearningInput; readonly nowMs?: number }): MethodPort | undefined {
  const learning = input.learning;
  if (learning === undefined) {
    return undefined;
  }
  const methodSwitch = methodSwitchFor(learning.switch);
  if (methodSwitch === undefined) {
    return undefined;
  }
  const nowMs = input.nowMs ?? 0;
  return wireMethodLearning({
    switch: methodSwitch,
    boardRoot: path.join(tryloHome(learning.homeDir, learning.env), "learning", "board"),
    now: () => new Date(nowMs).toISOString(),
    emit: learning.emit,
  });
}

/** What `wireMethodLearning` hands back: structurally the loop's method port. */
type MethodPort = NonNullable<LoopPorts["method"]>;
