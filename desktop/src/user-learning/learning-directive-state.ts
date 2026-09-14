import type { LearningDirective, ProductSurface } from './types';

export type LearningDirectiveByProduct = Partial<Record<ProductSurface, LearningDirective>>;

/** Immutable state transition used by the composer host. Code and Work are
 * separate one-shot slots so navigation cannot move a directive across products. */
export function setLearningDirectiveForProduct(
  current: LearningDirectiveByProduct,
  product: ProductSurface,
  directive: LearningDirective | undefined,
): LearningDirectiveByProduct {
  const next = { ...current };
  if (directive) next[product] = { ...directive };
  else delete next[product];
  return next;
}

/** Atomically returns the selected directive and the state after consumption.
 * Call only when a message has been accepted for dispatch or queuing. */
export function consumeLearningDirectiveForProduct(
  current: LearningDirectiveByProduct,
  product: ProductSurface,
): { readonly directive?: LearningDirective; readonly remaining: LearningDirectiveByProduct } {
  const directive = current[product];
  if (!directive) return { remaining: current };
  return {
    directive: { ...directive },
    remaining: setLearningDirectiveForProduct(current, product, undefined),
  };
}
