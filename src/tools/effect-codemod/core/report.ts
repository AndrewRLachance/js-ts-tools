import type { CorrelatedCallSite, SemanticFact } from "../contracts/semantics";
import type { CandidateReport } from "../contracts/report";

export function classifyReason(reason: string): CandidateReport["reasonCode"] {
  if (/limit|recurs|exceeded|budget/i.test(reason)) return "analysis-limit";
  if (/compound causes|Async mapping|Async handler|timing|side.effect|mutation|temporal-dead-zone|changes? behavior/i.test(reason)) return "semantic-difference";
  if (/not proven|unavailable|unresolved|binding|ambiguous|cannot preserve type refinement/i.test(reason)) return "missing-proof";
  if (/only|currently|must|requires?|unsupported|arity/i.test(reason)) return "unsupported-shape";
  return "not-applicable";
}

/** Keep proof facts useful to readers without copying every nested compiler record. */
export function compactEvidence(evidence: readonly SemanticFact[]): readonly SemanticFact[] {
  return evidence.flatMap((fact) => {
    if (fact.kind !== "call-site") return [fact];
    const data = fact.data as CorrelatedCallSite | undefined;
    if (!data?.callSite || data.strength !== "exact") return [];
    const call = data.callSite;
    return [{
      kind: fact.kind,
      summary: fact.summary,
      data: {
        strength: data.strength,
        callSite: {
          id: call.id,
          kind: call.kind,
          location: call.location,
          resolution: call.resolution,
          calleeSymbolId: call.calleeSymbolId,
          resultTypeId: call.resultTypeId,
        },
      },
    }];
  });
}
