import type { SemanticContext, SemanticFact, SemanticCallSite } from "../contracts/semantics";

export type SemanticGate<T> =
  | { readonly ok: true; readonly value: T; readonly evidence: readonly SemanticFact[] }
  | { readonly ok: false; readonly reason: string; readonly evidence: readonly SemanticFact[] };

/**
 * Automatic conversion must never proceed from a merely-contained or ambiguous
 * call-site association. TypeModel call sites are correlated by exact start location and compatible syntax kind. This helper centralizes that invariant for rules.
 */
export function requireSingleExactCallSite(
  candidateId: string,
  semantics: SemanticContext,
): SemanticGate<SemanticCallSite> {
  const evidence = semantics.factsFor(candidateId);
  const exact = semantics.callSitesFor(candidateId).filter((item) => item.strength === "exact");
  if (exact.length === 1 && exact[0]) {
    return { ok: true, value: exact[0].callSite, evidence };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous semantic correlation: ${exact.length} exact TypeModel call sites share this candidate start location.`,
      evidence,
    };
  }
  return {
    ok: false,
    reason: "No exact TypeModel call site is correlated with this candidate.",
    evidence,
  };
}

export function requireExactAstPattern(
  candidateId: string,
  requirementId: string,
  semantics: SemanticContext,
): SemanticGate<true> {
  const evidence = semantics.factsFor(candidateId);
  if (semantics.hasExactAstPattern(candidateId, requirementId)) {
    return { ok: true, value: true, evidence };
  }
  return {
    ok: false,
    reason: `Required AST-XPath pattern ${requirementId} does not exactly match this candidate.`,
    evidence,
  };
}
