import type { CallExpressionLike } from './ts-syntax';

/** Proofs for composed views; originals remain untouched and retain their locations. */
const applications = new WeakMap<object, { operator: string; resultIsEffect: boolean }>();
export function recordApplication(call: CallExpressionLike, operator: string): CallExpressionLike {
  applications.set(call, { operator, resultIsEffect: true });
  return call;
}
export function applicationProof(call: CallExpressionLike) { return applications.get(call); }
