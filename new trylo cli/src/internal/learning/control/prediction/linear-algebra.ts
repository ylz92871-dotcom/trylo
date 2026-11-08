import type {NumericMatrix, NumericVector, PredictionFailure} from './contracts.js';
import {unsupported} from './validation.js';

/** Only recognized numerical failures are converted at the public pure boundary. */
export class PredictionNumericalError extends Error {
  constructor(readonly failure: PredictionFailure) {
    super(failure.detail);
    this.name = 'PredictionNumericalError';
  }
}

export function numeric(value: number, stage: string): number {
  if (!Number.isFinite(value)) {
    throw new PredictionNumericalError(unsupported('numeric_range', `${stage}: non-finite arithmetic`));
  }
  return value;
}

export function unresolved(stage: string): never {
  throw new PredictionNumericalError(unsupported('numeric_range', stage));
}

export function stableSum(values: NumericVector, stage: string): number {
  let sum = 0;
  let correction = 0;

  for (const value of values) {
    const adjusted = numeric(value - correction, stage);
    const next = numeric(sum + adjusted, stage);
    correction = numeric((next - sum) - adjusted, stage);
    sum = next;
  }

  return sum;
}

export function dot(left: NumericVector, right: NumericVector): number {
  return stableSum(left.map((value, index) => numeric(value * right[index]!, 'dot product')), 'dot product');
}

export function squaredNorm(values: NumericVector): number {
  let norm = 0;
  for (const value of values) norm = numeric(Math.hypot(norm, value), 'norm');
  const square = numeric(norm * norm, 'squared norm');
  if (norm !== 0 && square === 0) unresolved('squared norm: nonzero factor variance underflow');
  return square;
}

export function cholesky(noise: NumericMatrix): number[][] {
  const lower = Array.from({length: noise.length}, () => Array<number>(noise.length).fill(0));

  for (let row = 0; row < noise.length; row++) {
    for (let column = 0; column <= row; column++) {
      let remainder = noise[row]![column]!;

      for (let index = 0; index < column; index++) {
        remainder = numeric(remainder - lower[row]![index]! * lower[column]![index]!, 'noise Cholesky');
      }

      if (row === column) {
        if (!(remainder > 0)) unresolved('noise Cholesky: SPD factorization unresolved');
        lower[row]![column] = numeric(Math.sqrt(remainder), 'noise Cholesky');
      } else {
        lower[row]![column] = numeric(remainder / lower[column]![column]!, 'noise Cholesky');
      }
    }
  }

  return lower;
}

export function whitenRows(lower: NumericMatrix, values: NumericMatrix, width: number): number[][] {
  const result = Array.from({length: lower.length}, () => Array<number>(width).fill(0));

  for (let row = 0; row < lower.length; row++) {
    for (let column = 0; column < width; column++) {
      let remainder = values[row]![column]!;
      for (let index = 0; index < row; index++) {
        remainder = numeric(remainder - lower[row]![index]! * result[index]![column]!, 'whitening');
      }
      result[row]![column] = numeric(remainder / lower[row]![row]!, 'whitening');
    }
  }

  return result;
}

/** Givens rotations transform the rhs along with every remaining feature column. */
export function triangularize(augmented: number[][], columns: number): void {
  const width = columns + 1;
  for (let column = 0; column < columns; column++) {
    for (let row = augmented.length - 1; row > column; row--) {
      const below = augmented[row]![column]!;
      if (below === 0) continue;

      const diagonal = augmented[column]![column]!;
      const radius = numeric(Math.hypot(diagonal, below), 'QR rotation');
      if (!(radius > 0)) unresolved('QR rotation: zero radius');

      const cosine = diagonal / radius;
      const sine = below / radius;

      for (let target = column + 1; target < width; target++) {
        const upperValue = augmented[column]![target]!;
        const lowerValue = augmented[row]![target]!;
        augmented[column]![target] = numeric(cosine * upperValue + sine * lowerValue, 'QR rotation');
        augmented[row]![target] = numeric(-sine * upperValue + cosine * lowerValue, 'QR rotation');
      }

      augmented[column]![column] = radius;
      augmented[row]![column] = 0;
    }
  }
}

export function solveUpper(upper: NumericMatrix, rhs: NumericVector): number[] {
  const result = Array<number>(upper.length).fill(0);

  for (let row = upper.length - 1; row >= 0; row--) {
    const diagonal = upper[row]![row]!;
    if (diagonal === 0) unresolved('posterior solve: zero pivot');

    let remainder = rhs[row]!;

    for (let column = row + 1; column < upper.length; column++) {
      remainder = numeric(remainder - upper[row]![column]! * result[column]!, 'posterior solve');
    }

    result[row] = numeric(remainder / diagonal, 'posterior solve');
  }

  return result;
}

/** row * U^-1, obtained by solving U^T * result^T = row^T. */
export function rightSolve(row: NumericVector, upper: NumericMatrix): number[] {
  const result = Array<number>(upper.length).fill(0);

  for (let column = 0; column < upper.length; column++) {
    const diagonal = upper[column]![column]!;
    if (diagonal === 0) unresolved('query solve: zero pivot');

    let remainder = row[column]!;

    for (let index = 0; index < column; index++) {
      remainder = numeric(remainder - result[index]! * upper[index]![column]!, 'query solve');
    }

    result[column] = numeric(remainder / diagonal, 'query solve');
  }

  return result;
}

export function logAbsDiagonal(upper: NumericMatrix): number {
  return stableSum(upper.map((row, index) => {
    const diagonal = row[index]!;
    if (diagonal === 0) unresolved('log determinant: zero pivot');
    return numeric(Math.log(Math.abs(diagonal)), 'log determinant');
  }), 'log determinant');
}

export function gram(factor: NumericMatrix): number[][] {
  const result = Array.from({length: factor.length}, () => Array<number>(factor.length).fill(0));

  for (let row = 0; row < factor.length; row++) {
    for (let column = row; column < factor.length; column++) {
      const value = row === column ? squaredNorm(factor[row]!) : dot(factor[row]!, factor[column]!);
      result[row]![column] = value;
      result[column]![row] = value;
    }
  }

  return result;
}
