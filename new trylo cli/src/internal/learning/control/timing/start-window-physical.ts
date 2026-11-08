import { failTiming } from "./boundary.js";
import type { ExactTiming, Rational } from "./exact.js";
import type { CompiledStartWindow, CompiledStartWorld, StartQuadratic } from "./start-window-contract.js";

export type StartBreakpoint = { readonly at: Rational; readonly kinds: Set<string> };

export function startPolynomial(q: StartQuadratic<Rational>, s: Rational, math: ExactTiming): Rational {
  return math.add(math.add(math.mul(q.a, math.mul(s, s)), math.mul(q.b, s)), q.c);
}

function occupancy(world: CompiledStartWorld, s: Rational, model: CompiledStartWindow, math: ExactTiming): Rational {
  let total = math.zero;

  for (const segment of world.profile) {
    const from = math.add(s, segment.u), to = math.add(s, segment.v);
    for (const phase of model.phases) {
      const length = math.max(math.zero, math.sub(math.min(to, phase.to), math.max(from, phase.from)));
      total = math.add(total, math.mul(math.mul(segment.load, phase.rate), length));
    }
  }

  return total;
}

export function startCost(model: CompiledStartWindow, s: Rational, math: ExactTiming): Rational {
  let total = math.mul(model.waitRate, s);
  for (const world of model.worlds) {
    // Late output cancels gross only: all future fees and occupancy remain paid.
    total = math.add(total, math.mul(world.p, math.add(world.futureFee, occupancy(world, s, model, math))));
  }
  return total;
}

export function startValue(model: CompiledStartWindow, s: Rational, math: ExactTiming): Rational {
  let gross = math.zero;

  for (const world of model.worlds) {
    if (math.compare(math.add(s, world.duration), world.useBy) <= 0) {
      gross = math.add(gross, math.mul(world.p, startPolynomial(world.gross, s, math)));
    }
  }

  return math.sub(gross, startCost(model, s, math));
}

export function startGain(model: CompiledStartWindow, interior: Rational, math: ExactTiming): StartQuadratic<Rational> {
  let a = math.zero, b = math.zero, c = math.zero;

  for (const world of model.worlds) {
    if (math.compare(math.add(interior, world.duration), world.useBy) <= 0) {
      a = math.add(a, math.mul(world.p, world.gross.a));
      b = math.add(b, math.mul(world.p, world.gross.b));
      c = math.add(c, math.mul(world.p, world.gross.c));
    }
  }

  return { a, b, c };
}

export function startBreakpoints(model: CompiledStartWindow, maximum: number, math: ExactTiming): readonly StartBreakpoint[] {
  const points = new Map<string, StartBreakpoint>();
  const insert = (at: Rational, kind: string) => {
    if (math.compare(at, model.lo) < 0 || math.compare(at, model.hi) > 0) return;
    const key = math.text(at), previous = points.get(key);
    if (previous !== undefined) {
      previous.kinds.add(kind);
      return;
    }
    if (points.size >= maximum) failTiming("planning_limit", "start_window_breakpoint_limit", "breakpoints");
    points.set(key, { at, kinds: new Set([kind]) });
  };

  insert(model.lo, "legal_interval_endpoint");
  insert(model.hi, "legal_interval_endpoint");

  for (const world of model.worlds) {
    insert(math.sub(world.useBy, world.duration), "soft_useBy_minus_duration");
    for (const segment of world.profile) for (const phase of model.phases) {
      for (const edge of [phase.from, phase.to]) {
        insert(math.sub(edge, segment.u), "interference_phase_offset");
        insert(math.sub(edge, segment.v), "interference_phase_offset");
      }
    }
  }

  return [...points.values()].sort((a, b) => math.compare(a.at, b.at));
}
