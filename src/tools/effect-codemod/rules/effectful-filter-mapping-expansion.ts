import type { EffectConversionRule } from "../contracts/rule";
import {
  arrowWithBodyText,
  callResultIsEffect,
  effectCallMatches,
  expressionCall,
  isArrowFunction,
  isConditionalExpression,
  isNegationOfIdentifier,
  isSameIdentifier,
  nodeText,
  singleArrowParameterIdentifier,
  unwrapParentheses,
} from "../core/ts-syntax";
import {
  convert,
  proveOuterEffectCall,
  rewriteWholeCandidate,
  skip,
} from "./effect-compositions";

/**
 * Effect v3 filterEffectOrElse is:
 * flatMap(self, a =>
 *   flatMap(options.predicate(a), pass =>
 *     pass ? succeed(a) : options.orElse(a)))
 */
export const filterEffectOrElseFromNestedFlatMapRule: EffectConversionRule = {
  id: "effect.filterEffectOrElse.from-nested-flatMap",
  target: "filterEffectOrElse",
  description: "Rewrite the canonical nested effectful predicate/fallback lowering to Effect.filterEffectOrElse.",
  selectors: [{
    id: "effect.filterEffectOrElse.from-nested-flatMap.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) {
      return skip("Outer Effect.flatMap must have exactly two arguments.", outer.value.evidence);
    }

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
    }
    const value = singleArrowParameterIdentifier(mapper);
    if (!value) return skip("Outer callback must have one simple identifier parameter.", outer.value.evidence);

    const inner = expressionCall(mapper.body, context.sourceText);
    if (!inner || inner.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, inner, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, inner)) {
      return skip("Outer callback must directly return a proven Effect.flatMap(predicateEffect, callback).", outer.value.evidence);
    }

    const [predicateEffectNode, passMapper] = inner.arguments;
    if (!predicateEffectNode || !passMapper || !isArrowFunction(passMapper)) {
      return skip("Inner Effect.flatMap arguments are incomplete.", outer.value.evidence);
    }
    const predicateEffect = expressionCall(predicateEffectNode, context.sourceText);
    if (!predicateEffect || !callResultIsEffect(context.semantics, candidate.filePath, predicateEffect)) {
      return skip("Predicate expression must be a call proven to return Effect<boolean, ...>.", outer.value.evidence);
    }
    const pass = singleArrowParameterIdentifier(passMapper);
    if (!pass) return skip("Predicate-result callback must have one simple identifier parameter.", outer.value.evidence);

    const conditional = unwrapParentheses(passMapper.body, context.sourceText);
    if (!isConditionalExpression(conditional) || !isSameIdentifier(conditional.condition, pass, context.sourceText)) {
      return skip("Predicate-result callback must branch directly on its boolean parameter.", outer.value.evidence);
    }

    const succeed = expressionCall(conditional.whenTrue, context.sourceText);
    const fallback = expressionCall(conditional.whenFalse, context.sourceText);
    if (!succeed || !fallback || succeed.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, fallback)) {
      return skip("Branches must be proven Effect.succeed(value) and an Effect-producing fallback call.", outer.value.evidence);
    }
    const successValue = succeed.arguments[0];
    if (!successValue || !isSameIdentifier(successValue, value, context.sourceText)) {
      return skip("Success branch must preserve the outer callback value unchanged.", outer.value.evidence);
    }

    if (effectCallMatches(context.semantics, candidate.filePath, fallback, "fail") && fallback.arguments.length === 1) {
      return skip("Effect.fail fallback is reserved for the more specific Effect.filterEffectOrFail rule.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, predicateEffectNode, context.sourceText);
    const orElse = arrowWithBodyText(mapper, conditional.whenFalse, context.sourceText);
    const replacementText = `__codemod_Effect__.filterEffectOrElse(${nodeText(self, context.sourceText)}, { predicate: ${predicate}, orElse: ${orElse} })`;
    return convert(
      this.id,
      this.target,
      candidate,
      outer.value.evidence,
      replacementText,
      "Matches Effect v3 filterEffectOrElse nested flatMap semantics without moving predicate/fallback evaluation out of their callbacks.",
    );
  },
  rewrite: rewriteWholeCandidate,
};

/** Effect v3 filterEffectOrFail specializes filterEffectOrElse with Effect.fail. */
export const filterEffectOrFailFromNestedFlatMapRule: EffectConversionRule = {
  id: "effect.filterEffectOrFail.from-nested-flatMap-fail",
  target: "filterEffectOrFail",
  description: "Rewrite the canonical nested effectful predicate/Effect.fail lowering to Effect.filterEffectOrFail.",
  selectors: [{
    id: "effect.filterEffectOrFail.from-nested-flatMap-fail.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) {
      return skip("Outer Effect.flatMap must have exactly two arguments.", outer.value.evidence);
    }

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
    }
    const value = singleArrowParameterIdentifier(mapper);
    if (!value) return skip("Outer callback must have one simple identifier parameter.", outer.value.evidence);

    const inner = expressionCall(mapper.body, context.sourceText);
    if (!inner || inner.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, inner, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, inner)) {
      return skip("Outer callback must directly return a proven Effect.flatMap(predicateEffect, callback).", outer.value.evidence);
    }

    const [predicateEffectNode, passMapper] = inner.arguments;
    if (!predicateEffectNode || !passMapper || !isArrowFunction(passMapper)) {
      return skip("Inner Effect.flatMap arguments are incomplete.", outer.value.evidence);
    }
    const predicateEffect = expressionCall(predicateEffectNode, context.sourceText);
    if (!predicateEffect || !callResultIsEffect(context.semantics, candidate.filePath, predicateEffect)) {
      return skip("Predicate expression must be a call proven to return Effect<boolean, ...>.", outer.value.evidence);
    }
    const pass = singleArrowParameterIdentifier(passMapper);
    if (!pass) return skip("Predicate-result callback must have one simple identifier parameter.", outer.value.evidence);

    const conditional = unwrapParentheses(passMapper.body, context.sourceText);
    if (!isConditionalExpression(conditional) || !isSameIdentifier(conditional.condition, pass, context.sourceText)) {
      return skip("Predicate-result callback must branch directly on its boolean parameter.", outer.value.evidence);
    }

    const succeed = expressionCall(conditional.whenTrue, context.sourceText);
    const fail = expressionCall(conditional.whenFalse, context.sourceText);
    if (!succeed || !fail || succeed.arguments.length !== 1 || fail.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !effectCallMatches(context.semantics, candidate.filePath, fail, "fail")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, fail)) {
      return skip("Branches must be proven Effect.succeed(value) and Effect.fail(error).", outer.value.evidence);
    }
    const successValue = succeed.arguments[0];
    const error = fail.arguments[0];
    if (!successValue || !error || !isSameIdentifier(successValue, value, context.sourceText)) {
      return skip("Success branch must preserve the outer callback value unchanged.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, predicateEffectNode, context.sourceText);
    const orFailWith = arrowWithBodyText(mapper, error, context.sourceText);
    const replacementText = `__codemod_Effect__.filterEffectOrFail(${nodeText(self, context.sourceText)}, { predicate: ${predicate}, orFailWith: ${orFailWith} })`;
    return convert(
      this.id,
      this.target,
      candidate,
      outer.value.evidence,
      replacementText,
      "Matches Effect v3 filterEffectOrFail specialization; failure construction remains lazy inside orFailWith.",
    );
  },
  rewrite: rewriteWholeCandidate,
};

/** Effect v3 negate is map(self, b => !b). */
export const negateFromMapBooleanNotRule: EffectConversionRule = {
  id: "effect.negate.from-map-not",
  target: "negate",
  description: "Rewrite Effect.map(effect, b => !b) to Effect.negate.",
  selectors: [{
    id: "effect.negate.from-map-not.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.map with an arrow callback is supported.", outer.value.evidence);
    }
    const value = singleArrowParameterIdentifier(mapper);
    if (!value || !isNegationOfIdentifier(mapper.body, value, context.sourceText)) {
      return skip("Mapper must be exactly a one-parameter boolean negation.", outer.value.evidence);
    }

    return convert(
      this.id,
      this.target,
      candidate,
      outer.value.evidence,
      `__codemod_Effect__.negate(${nodeText(self, context.sourceText)})`,
      "Effect v3 negate is exactly Effect.map(self, b => !b).",
    );
  },
  rewrite: rewriteWholeCandidate,
};

export const EFFECTFUL_FILTER_MAPPING_EXPANSION_RULES: readonly EffectConversionRule[] = [
  filterEffectOrElseFromNestedFlatMapRule,
  filterEffectOrFailFromNestedFlatMapRule,
  negateFromMapBooleanNotRule,
];
