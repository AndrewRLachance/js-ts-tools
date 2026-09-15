import type { EffectConversionRule } from "../contracts/rule";
import { isArrowFunction, nodeText } from "../core/ts-syntax";
import { proveOuterEffectCall, rewriteWholeCandidate, skip } from "./effect-compositions";

export const orElseFailFromMapErrorRule: EffectConversionRule = {
  id: "effect.orElseFail.from-mapError-lazy-error",
  target: "orElseFail",
  description: "Suggest orElseFail for error-independent mapError callbacks, subject to cause-semantics review.",
  selectors: [{ id: "effect.orElseFail.from-mapError-lazy-error.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="mapError"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "mapError", true);
    if (!outer.ok) return outer.decision;
    const { call, evidence, dataLast } = outer.value;
    if (call.arguments.length !== (dataLast ? 1 : 2)) return skip("Unexpected Effect.mapError arity.", evidence);
    const mapper = call.arguments[dataLast ? 0 : 1];
    // Keep the arrow intact: its body stays lazy and retains lexical this/arguments.
    // Function expressions can observe the old error through their own arguments.
    if (!mapper || !isArrowFunction(mapper) || mapper.parameters.length !== 0) {
      return skip("Error mapping uses the original error or is not a zero-parameter arrow.", evidence);
    }
    const args = call.arguments.map((arg) => nodeText(arg, context.sourceText)).join(", ");
    const reference = context.analysis?.effectReference(candidate.nativeNode as import("typescript").Node);
    const replacementText = `${reference?.text ?? "Effect"}.orElseFail(${args})`;
    return {
      kind: "review",
      reason: "orElseFail keeps the error factory lazy but handles compound causes and interruption differently from mapError; equivalence requires application-specific review.",
      match: {
        ruleId: this.id,
        target: this.target,
        candidate,
        captures: {},
        confidence: "review",
        evidence: [...evidence, { kind: "custom", summary: "Possible lazy error replacement; never applied automatically.", data: { replacementText } }],
        metadata: { replacementText },
      },
    };
  },
  rewrite: rewriteWholeCandidate,
};
