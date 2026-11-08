import { failTiming, requireTiming } from "./boundary.js";

export type ExactLiteral = number | string;

export type Rational = Readonly<{ n: bigint; d: bigint }>;

export const MAX_TIMING_BITS = 4096;

export function readTimingBits(value: unknown = MAX_TIMING_BITS): number {
  requireTiming(typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMING_BITS,
    "invalid_numeric_bits", "options.maxBits");
  return value;
}

const absolute = (value: bigint): bigint => value < 0n ? -value : value;

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

/** Bounded exact work, not a floating approximation or an execution budget. */
export class ExactTiming {
  readonly zero: Rational;
  readonly one: Rational;
  readonly #issued = new WeakSet<object>();
  private readonly magnitudeLimit: bigint;
  private readonly decimalLimit: string;

  constructor(private readonly maxBits: number = MAX_TIMING_BITS) {
    readTimingBits(maxBits);
    // The single guard bit constructs the fixed instance mask, as in the research kernel.
    this.magnitudeLimit = (1n << BigInt(maxBits)) - 1n;
    this.decimalLimit = this.magnitudeLimit.toString();
    this.zero = this.make(0n, 1n, "zero");
    this.one = this.make(1n, 1n, "one");
    Object.freeze(this);
  }

  from(value: unknown, at = "number"): Rational {
    if (typeof value === "number") return this.fromNumber(value, at);

    requireTiming(typeof value === "string", "exact_literal_required", at);
    requireTiming(value.length <= 2 * this.decimalLimit.length + 2
      && /^-?(?:0|[1-9][0-9]*)\/[1-9][0-9]*$/.test(value), "invalid_fraction_literal", at);
    const slash = value.indexOf("/");
    const numerator = value.slice(0, slash), denominator = value.slice(slash + 1);

    this.checkDecimal(numerator.startsWith("-") ? numerator.slice(1) : numerator, at);
    this.checkDecimal(denominator, at);

    return this.make(BigInt(numerator), BigInt(denominator), at);
  }

  add(left: Rational, right: Rational): Rational { return this.combine(left, right, false, "add"); }

  sub(left: Rational, right: Rational): Rational { return this.combine(left, right, true, "sub"); }

  mul(left: Rational, right: Rational): Rational { return this.product(left, right, false, "mul"); }

  div(left: Rational, right: Rational): Rational { return this.product(left, right, true, "div"); }

  compare(left: Rational, right: Rational): -1 | 0 | 1 {
    this.own(left, "compare");
    this.own(right, "compare");

    if (left.n === right.n && left.d === right.d) return 0;

    if (left.n < 0n && right.n >= 0n) return -1;

    if (left.n >= 0n && right.n < 0n) return 1;

    const common = gcd(left.d, right.d);
    const leftProduct = this.checkedProduct(left.n, right.d / common, "compare");
    const rightProduct = this.checkedProduct(right.n, left.d / common, "compare");

    return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0;
  }

  min(left: Rational, right: Rational): Rational { return this.compare(left, right) <= 0 ? left : right; }

  max(left: Rational, right: Rational): Rational { return this.compare(left, right) >= 0 ? left : right; }

  normalize(weights: readonly Rational[], at = "weights"): readonly Rational[] {
    requireTiming(Array.isArray(weights) && weights.length > 0, "nonempty_weights_required", at);
    let total = this.zero;

    for (const weight of weights) {
      this.own(weight, at);
      requireTiming(weight.n >= 0n, "negative_weight", at);
      total = this.combine(total, weight, false, at);
    }

    requireTiming(total.n > 0n, "zero_weight_total", at);

    return Object.freeze(weights.map(weight => this.product(weight, total, true, at)));
  }

  text(value: Rational): string {
    this.own(value, "text");
    return `${value.n}/${value.d}`;
  }

  private checkDecimal(digits: string, at: string): void {
    if (digits.length > this.decimalLimit.length
      || (digits.length === this.decimalLimit.length && digits > this.decimalLimit)) this.limit(at);
  }

  private own(value: Rational, at: string): void {
    requireTiming(typeof value === "object" && value !== null && this.#issued.has(value),
      "foreign_or_invalid_rational", at);
  }

  private limit(at: string): never { return failTiming("numeric_limit", "rational_work_bits", at); }

  private make(numerator: bigint, denominator: bigint, at: string): Rational {
    requireTiming(denominator !== 0n, "division_by_zero", at);

    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }

    if (absolute(numerator) > this.magnitudeLimit || denominator > this.magnitudeLimit) this.limit(at);

    if (numerator === 0n) denominator = 1n;

    const common = gcd(absolute(numerator), denominator);
    const value = Object.freeze({ n: numerator / common, d: denominator / common });

    this.#issued.add(value);

    return value;
  }

  private checkedProduct(left: bigint, right: bigint, at: string): bigint {
    if (left === 0n || right === 0n) return 0n;
    if (absolute(left) > this.magnitudeLimit / absolute(right)) this.limit(at);
    return left * right;
  }

  private checkedSum(left: bigint, right: bigint, at: string): bigint {
    if (((left > 0n && right > 0n) || (left < 0n && right < 0n))
      && absolute(left) > this.magnitudeLimit - absolute(right)) this.limit(at);
    return left + right;
  }

  private fromNumber(value: number, at: string): Rational {
    requireTiming(Number.isFinite(value), "finite_number_required", at);

    if (value === 0) return this.zero;

    const view = new DataView(new ArrayBuffer(8));

    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    let significand = bits & ((1n << 52n) - 1n), exponent = -1074;

    if (exponentBits !== 0) {
      significand |= 1n << 52n;
      exponent = exponentBits - 1023 - 52;
    }

    while ((significand & 1n) === 0n) {
      significand >>= 1n;
      exponent += 1;
    }

    if (significand > this.magnitudeLimit) this.limit(at);

    let numerator = significand, denominator = 1n;

    if (exponent >= 0) {
      if (exponent >= this.maxBits || numerator > (this.magnitudeLimit >> BigInt(exponent))) this.limit(at);
      numerator <<= BigInt(exponent);
    } else {
      if (-exponent >= this.maxBits) this.limit(at);
      denominator <<= BigInt(-exponent);
    }

    return this.make((bits >> 63n) !== 0n ? -numerator : numerator, denominator, at);
  }

  private combine(left: Rational, right: Rational, subtract: boolean, at: string): Rational {
    this.own(left, at);
    this.own(right, at);
    const common = gcd(left.d, right.d);
    const leftTerm = this.checkedProduct(left.n, right.d / common, at);
    const rightTerm = this.checkedProduct(subtract ? -right.n : right.n, left.d / common, at);
    const numerator = this.checkedSum(leftTerm, rightTerm, at);
    const cancellation = gcd(absolute(numerator), common);
    const denominator = this.checkedProduct(left.d / common, right.d / cancellation, at);

    return this.make(numerator / cancellation, denominator, at);
  }

  private product(left: Rational, right: Rational, divide: boolean, at: string): Rational {
    this.own(left, at);
    this.own(right, at);
    requireTiming(!divide || right.n !== 0n, "division_by_zero", at);
    let rightN = divide ? right.d : right.n, rightD = divide ? right.n : right.d;
    if (rightD < 0n) {
      rightN = -rightN;
      rightD = -rightD;
    }

    const crossLeft = gcd(absolute(left.n), rightD), crossRight = gcd(absolute(rightN), left.d);

    return this.make(this.checkedProduct(left.n / crossLeft, rightN / crossRight, at),
      this.checkedProduct(left.d / crossRight, rightD / crossLeft, at), at);
  }
}
