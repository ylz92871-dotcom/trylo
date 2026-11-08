import { failTiming } from "./boundary.js";
import type { ExactTiming, Rational } from "./exact.js";
import type { CompiledStartWindow, LearningStartWindowAnalysis, StartQuadratic, StartWindowCell,
  StartWindowConstant, StartWindowWitness, StartWitnessKind } from "./start-window-contract.js";
import { startBreakpoints, startCost, startGain, startPolynomial, startValue, type StartBreakpoint } from "./start-window-physical.js";

type Point = { readonly start: Rational; readonly value: Rational; readonly kinds: StartWitnessKind[] };

type Cell = {
  readonly lo: Rational; readonly hi: Rational; readonly midpoint: Point;
  readonly gain: StartQuadratic<Rational>; readonly net: StartQuadratic<Rational>;
  readonly slope: Rational; readonly intercept: Rational; readonly costLo: Rational; readonly costHi: Rational;
  readonly leftLimit: Rational; readonly rightLimit: Rational; readonly vertex: Point | null; readonly flat: boolean;
};

type Limit = { readonly value: Rational; readonly at: Rational; readonly side: "right" | "left"; readonly cell: number };

export type StartWindowEvaluationOptions = {
  readonly modelHash: string; readonly maxBreakpoints: number; readonly maxCandidates: number;
  readonly requestedRegret: Rational | null;
};

class StartCandidates {
  private readonly actual = new Map<string, Point>();
  private readonly cells: Cell[] = [];
  private readonly limits: Limit[] = [];
  private count = 0;
  private readonly two: Rational;

  constructor(private readonly model: CompiledStartWindow, private readonly math: ExactTiming,
    private readonly maximum: number) { this.two = math.from(2); }

  private spend(): void {
    this.count += 1;
    if (this.count > this.maximum) failTiming("planning_limit", "start_window_candidate_limit", "candidates");
  }

  private point(start: Rational, kind: StartWitnessKind): Point {
    const key = this.math.text(start);
    let point = this.actual.get(key);
    if (point === undefined) {
      this.spend();
      point = { start, value: startValue(this.model, start, this.math), kinds: [] };
      this.actual.set(key, point);
    }
    point.kinds.push(kind);
    return point;
  }

  private knownPoint(start: Rational): Point {
    const point = this.actual.get(this.math.text(start));
    if (point === undefined) throw new Error("start_window_boundary_not_evaluated");
    return point;
  }

  private addCell(lo: Rational, hi: Rational): void {
    const m = this.math, midpoint = this.point(m.div(m.add(lo, hi), this.two), "cell_midpoint");
    const costLo = startCost(this.model, lo, m), costHi = startCost(this.model, hi, m);
    // All profile/phase crossings are boundaries: this physical cost is proven affine.
    const slope = m.div(m.sub(costHi, costLo), m.sub(hi, lo));
    const intercept = m.sub(costLo, m.mul(slope, lo)), gain = startGain(this.model, midpoint.start, m);
    const net = { a: gain.a, b: m.sub(gain.b, slope), c: m.sub(gain.c, intercept) };
    const leftLimit = startPolynomial(net, lo, m), rightLimit = startPolynomial(net, hi, m);
    const index = this.cells.length;

    this.spend();
    this.limits.push({ value: leftLimit, at: lo, side: "right", cell: index });
    this.spend();
    this.limits.push({ value: rightLimit, at: hi, side: "left", cell: index });
    let vertex: Point | null = null;

    if (m.compare(net.a, m.zero) < 0) {
      const at = m.div(m.sub(m.zero, net.b), m.mul(this.two, net.a));
      if (m.compare(lo, at) < 0 && m.compare(at, hi) < 0) vertex = this.point(at, "joint_concave_vertex");
    }

    this.cells.push({ lo, hi, midpoint, gain, net, slope, intercept, costLo, costHi, leftLimit, rightLimit, vertex,
      flat: m.compare(net.a, m.zero) === 0 && m.compare(net.b, m.zero) === 0 });
  }

  private best(): Point {
    let best: Point | undefined;
    for (const point of this.actual.values()) if (best === undefined || this.math.compare(point.value, best.value) > 0) best = point;
    if (best === undefined) throw new Error("start_window_no_legal_witness");
    return best;
  }

  private improveRegret(supremum: Rational, epsilon: Rational): void {
    const m = this.math, limit = this.limits.find(item => m.compare(item.value, supremum) === 0);
    const cell = limit === undefined ? undefined : this.cells[limit.cell];
    if (limit === undefined || cell === undefined) throw new Error("start_window_unattained_limit_missing");

    const abs = (value: Rational) => m.max(value, m.sub(m.zero, value));
    const derivative = (at: Rational) => m.add(m.mul(m.mul(this.two, cell.net.a), at), cell.net.b);
    const L = m.max(abs(derivative(cell.lo)), abs(derivative(cell.hi)));
    if (m.compare(L, m.zero) === 0) throw new Error("start_window_unattained_flat_cell");

    const delta = m.min(m.div(m.sub(cell.hi, cell.lo), this.two), m.div(epsilon, L));
    const start = limit.side === "right" ? m.add(limit.at, delta) : m.sub(limit.at, delta);
    if (m.compare(cell.lo, start) >= 0 || m.compare(start, cell.hi) >= 0) throw new Error("start_window_regret_point_not_interior");

    // Re-evaluate the complete physical objective, including actual useBy and all fees.
    const point = this.point(start, "requested_regret"), gap = m.sub(supremum, point.value);
    if (m.compare(gap, m.zero) <= 0 || m.compare(gap, epsilon) > 0) throw new Error("start_window_regret_bound_inconsistent");
  }

  private textPoint(point: Point): StartWindowWitness {
    return { start: this.math.text(point.start), value: this.math.text(point.value), kinds: [...point.kinds] };
  }

  private textQuadratic(q: StartQuadratic<Rational>): StartQuadratic<string> {
    return { a: this.math.text(q.a), b: this.math.text(q.b), c: this.math.text(q.c) };
  }

  private textCell(cell: Cell): StartWindowCell {
    const m = this.math;
    return { lo: m.text(cell.lo), hi: m.text(cell.hi), midpointWitness: this.textPoint(cell.midpoint),
      gainQuadratic: this.textQuadratic(cell.gain), netQuadratic: this.textQuadratic(cell.net),
      costAffine: { slope: m.text(cell.slope), intercept: m.text(cell.intercept), costLo: m.text(cell.costLo), costHi: m.text(cell.costHi) },
      leftLimit: m.text(cell.leftLimit), rightLimit: m.text(cell.rightLimit),
      vertex: cell.vertex === null ? null : this.textPoint(cell.vertex), flat: cell.flat };
  }

  private constantWindows(supremum: Rational): readonly StartWindowConstant[] {
    const m = this.math;
    return this.cells.filter(cell => cell.flat).map(cell => ({
      lo: m.text(cell.lo), hi: m.text(cell.hi), value: m.text(cell.net.c), interior: "open" as const,
      cooptimal: m.compare(cell.net.c, supremum) === 0,
      includeLo: m.compare(this.knownPoint(cell.lo).value, cell.net.c) === 0,
      includeHi: m.compare(this.knownPoint(cell.hi).value, cell.net.c) === 0,
    }));
  }

  run(points: readonly StartBreakpoint[], options: StartWindowEvaluationOptions): LearningStartWindowAnalysis {
    const m = this.math;

    for (const point of points) this.point(point.at, "actual_boundary");

    for (let index = 0; index + 1 < points.length; index += 1) this.addCell(points[index]!.at, points[index + 1]!.at);

    let best = this.best(), supremum = best.value;

    for (const limit of this.limits) if (m.compare(limit.value, supremum) > 0) supremum = limit.value;

    const attained = m.compare(best.value, supremum) === 0;
    if (!attained && options.requestedRegret !== null && m.compare(m.sub(supremum, best.value), options.requestedRegret) > 0) {
      this.improveRegret(supremum, options.requestedRegret);
      best = this.best();
    }

    const windows = this.constantWindows(supremum);
    const common = { ...this.model.identity, modelHash: options.modelHash,
      scope: "one_fixed_program_no_observation_closed_start_family" as const,
      maximumOrSupremum: m.text(supremum), bestKnown: this.textPoint(best), gap: m.text(m.sub(supremum, best.value)),
      requestedRegret: options.requestedRegret === null ? null : m.text(options.requestedRegret),
      supremumLimitSides: this.limits.filter(limit => m.compare(limit.value, supremum) === 0).map(limit => {
        const cell = this.cells[limit.cell];
        if (cell === undefined) throw new Error("start_window_limit_cell_missing");
        return { value: m.text(limit.value), at: m.text(limit.at), side: limit.side, cell: { lo: m.text(cell.lo), hi: m.text(cell.hi) } };
      }),
      actualBoundaryValues: points.map(point => ({ at: m.text(point.at), value: m.text(this.knownPoint(point.at).value), kinds: [...point.kinds] })),
      cells: this.cells.map(cell => this.textCell(cell)), constantWindows: windows,
      cooptimalWindows: windows.filter(window => window.cooptimal), candidateCount: this.count, breakpointCount: points.length };

    return attained ? { ...common, status: "max_attained", maximizer: this.textPoint(best) }
      : { ...common, status: "supremum_unattained", maximizer: null };
  }
}

export function evaluateStartWindow(model: CompiledStartWindow, math: ExactTiming,
  options: StartWindowEvaluationOptions): LearningStartWindowAnalysis {
  const points = startBreakpoints(model, options.maxBreakpoints, math);
  return new StartCandidates(model, math, options.maxCandidates).run(points, options);
}
