import type { EffectConversionRule } from "../contracts/rule";
import {
  arrowWithBodyText,
  callResultIsEffect,
  effectCallMatches,
  effectModuleCallMatches,
  expressionCall,
  hasOnlyObjectProperties,
  hasSimpleArrowParameters,
  isArrowFunction,
  isAsyncArrow,
  isConditionalExpression,
  isObjectLiteralExpression,
  isPrimitiveLiteralExpression,
  isSameIdentifier,
  isVoidProducingArrowBody,
  nodeText,
  objectPropertyInitializer,
  singleArrowParameterIdentifier,
  unwrapParentheses,
} from "../core/ts-syntax";
import {
  convert,
  proveOuterEffectCall,
  rewriteWholeCandidate,
  skip,
} from "./effect-compositions";

export const asFromMapConstantPrimitiveRule: EffectConversionRule = {
  id: "effect.as.from-map-constant-primitive",
  target: "as",
  description: "Rewrite Effect.map(self, () => primitiveLiteral) to Effect.as(self, primitiveLiteral).",
  selectors: [{
    id: "effect.as.from-map-constant-primitive.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map", true);
    if (!outer.ok) return outer.decision;
    const { dataLast } = outer.value;
    if (outer.value.call.arguments.length !== (dataLast ? 1 : 2)) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const self = dataLast ? undefined : outer.value.call.arguments[0];
    const mapper = outer.value.call.arguments[dataLast ? 0 : 1];
    if (!mapper || !isArrowFunction(mapper) || !hasSimpleArrowParameters(mapper, 1)) {
      return skip("Constant mapping requires an arrow callback with at most one simple parameter.", outer.value.evidence);
    }

    const body = unwrapParentheses(mapper.body, context.sourceText);
    if (isAsyncArrow(mapper)) return skip("Async mapping returns a Promise and cannot be replaced by Effect.as.", outer.value.evidence);
    if (!isPrimitiveLiteralExpression(body, context.sourceText)) {
      return skip("Only primitive literals are moved from callback execution time to Effect.as construction time.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.as(${self ? `${nodeText(self, context.sourceText)}, ` : ""}${nodeText(body, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Primitive literal mapping is timing-insensitive and equivalent to Effect.as.");
  },
  rewrite: rewriteWholeCandidate,
};

export const asVoidFromMapRule: EffectConversionRule = {
  id: "effect.asVoid.from-map-void",
  target: "asVoid",
  description: "Rewrite Effect.map(self, () => void 0 / {}) to Effect.asVoid(self).",
  selectors: [{
    id: "effect.asVoid.from-map-void.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map", true);
    if (!outer.ok) return outer.decision;
    const { dataLast } = outer.value;
    if (outer.value.call.arguments.length !== (dataLast ? 1 : 2)) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const self = dataLast ? undefined : outer.value.call.arguments[0];
    const mapper = outer.value.call.arguments[dataLast ? 0 : 1];
    if (!mapper || !isArrowFunction(mapper) || !hasSimpleArrowParameters(mapper, 1)) {
      return skip("Void mapping requires an arrow callback with at most one simple parameter.", outer.value.evidence);
    }
    if (isAsyncArrow(mapper)) return skip("Async mapping returns a Promise and cannot be replaced by Effect.asVoid.", outer.value.evidence);
    if (!isVoidProducingArrowBody(mapper.body, context.sourceText)) {
      return skip("Mapper is not a side-effect-free void-producing body.", outer.value.evidence);
    }

    const replacementText = self ? `__codemod_Effect__.asVoid(${nodeText(self, context.sourceText)})` : "__codemod_Effect__.asVoid";
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Side-effect-free void mapping is equivalent to Effect.asVoid.");
  },
  rewrite: rewriteWholeCandidate,
};

export const asSomeFromMapOptionSomeRule: EffectConversionRule = {
  id: "effect.asSome.from-map-option-some",
  target: "asSome",
  description: "Rewrite Effect.map(self, value => Option.some(value)) to Effect.asSome(self).",
  selectors: [{
    id: "effect.asSome.from-map-option-some.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) return skip("Mapper must be an arrow function.", outer.value.evidence);
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Mapper must have one simple identifier parameter.", outer.value.evidence);

    const some = expressionCall(mapper.body, context.sourceText);
    if (!some || some.arguments.length !== 1) return skip("Mapper must directly call Option.some(value).", outer.value.evidence);
    if (!effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")) {
      return skip("Nested constructor is not proven Option.some.", outer.value.evidence);
    }
    const value = some.arguments[0];
    if (!value || !isSameIdentifier(value, parameter, context.sourceText)) {
      return skip("Option.some must wrap the mapper parameter unchanged.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.asSome(${nodeText(self, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity Option.some mapping is equivalent to Effect.asSome.");
  },
  rewrite: rewriteWholeCandidate,
};

export const asSomeErrorFromMapErrorOptionSomeRule: EffectConversionRule = {
  id: "effect.asSomeError.from-mapError-option-some",
  target: "asSomeError",
  description: "Rewrite Effect.mapError(self, error => Option.some(error)) to Effect.asSomeError(self).",
  selectors: [{
    id: "effect.asSomeError.from-mapError-option-some.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="mapError"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "mapError");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.mapError must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) return skip("Error mapper must be an arrow function.", outer.value.evidence);
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Error mapper must have one simple identifier parameter.", outer.value.evidence);

    const some = expressionCall(mapper.body, context.sourceText);
    if (!some || some.arguments.length !== 1) return skip("Error mapper must directly call Option.some(error).", outer.value.evidence);
    if (!effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")) {
      return skip("Nested constructor is not proven Option.some.", outer.value.evidence);
    }
    const error = some.arguments[0];
    if (!error || !isSameIdentifier(error, parameter, context.sourceText)) {
      return skip("Option.some must wrap the error parameter unchanged.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.asSomeError(${nodeText(self, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity Option.some error mapping is equivalent to Effect.asSomeError.");
  },
  rewrite: rewriteWholeCandidate,
};

export const mapErrorCauseFromCatchAllCauseFailCauseRule: EffectConversionRule = {
  id: "effect.mapErrorCause.from-catchAllCause-failCause",
  target: "mapErrorCause",
  description: "Rewrite Effect.catchAllCause(self, cause => Effect.failCause(f(cause))) to Effect.mapErrorCause.",
  selectors: [{
    id: "effect.mapErrorCause.from-catchAllCause-failCause.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="catchAllCause"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "catchAllCause");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.catchAllCause must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.catchAllCause with an arrow callback is supported.", outer.value.evidence);
    }
    const failCause = expressionCall(mapper.body, context.sourceText);
    if (!failCause || failCause.arguments.length !== 1) {
      return skip("The catchAllCause callback must directly return Effect.failCause(cause).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, failCause, "failCause")
      || !callResultIsEffect(context.semantics, candidate.filePath, failCause)) {
      return skip("Nested callback result is not proven to be Effect.failCause.", outer.value.evidence);
    }

    const cause = failCause.arguments[0];
    if (!cause) return skip("Effect.failCause argument is missing.", outer.value.evidence);
    const replacementText = `__codemod_Effect__.mapErrorCause(${nodeText(self, context.sourceText)}, ${arrowWithBodyText(mapper, cause, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Proven catchAllCause+failCause equivalence.");
  },
  rewrite: rewriteWholeCandidate,
};

export const filterOrElseFromFlatMapRule: EffectConversionRule = {
  id: "effect.filterOrElse.from-flatMap-conditional",
  target: "filterOrElse",
  description: "Rewrite flatMap identity validation with an effectful fallback to Effect.filterOrElse.",
  selectors: [{
    id: "effect.filterOrElse.from-flatMap-conditional.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) return skip("Validation callback must be an arrow.", outer.value.evidence);
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Validation callback must have one simple identifier parameter.", outer.value.evidence);

    const body = unwrapParentheses(mapper.body, context.sourceText);
    if (!isConditionalExpression(body)) {
      return skip("Validation callback body must be a conditional expression.", outer.value.evidence);
    }
    const conditional = body;
    const succeed = expressionCall(conditional.whenTrue, context.sourceText);
    const fallback = expressionCall(conditional.whenFalse, context.sourceText);
    if (!succeed || succeed.arguments.length !== 1 || !fallback) {
      return skip("Conditional must preserve the value with Effect.succeed and use a direct effectful fallback call.", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, fallback)) {
      return skip("Conditional branches are not proven Effect-valued calls.", outer.value.evidence);
    }
    if (["fail", "die", "dieMessage"].some((name) => effectCallMatches(context.semantics, candidate.filePath, fallback, name))) {
      return skip("Fallback has a more specific filter combinator and is intentionally left to that rule family.", outer.value.evidence);
    }
    const successValue = succeed.arguments[0];
    if (!successValue || !isSameIdentifier(successValue, parameter, context.sourceText)) {
      return skip("Success branch must preserve the callback parameter unchanged.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, conditional.condition, context.sourceText);
    const orElse = arrowWithBodyText(mapper, fallback, context.sourceText);
    const replacementText = `__codemod_Effect__.filterOrElse(${nodeText(self, context.sourceText)}, ${predicate}, ${orElse})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity success branch plus effectful fallback is equivalent to Effect.filterOrElse.");
  },
  rewrite: rewriteWholeCandidate,
};

export const mapBothFromMatchEffectRule: EffectConversionRule = {
  id: "effect.mapBoth.from-matchEffect-fail-succeed",
  target: "mapBoth",
  description: "Rewrite Effect.matchEffect channel-only fail/succeed handlers to Effect.mapBoth.",
  selectors: [{
    id: "effect.mapBoth.from-matchEffect-fail-succeed.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="matchEffect"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "matchEffect");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.matchEffect must have exactly two arguments.", outer.value.evidence);

    const [self, optionsNode] = outer.value.call.arguments;
    if (!self || !optionsNode) return skip("Effect.matchEffect arguments are incomplete.", outer.value.evidence);
    const options = unwrapParentheses(optionsNode, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["onFailure", "onSuccess"], context.sourceText)) {
      return skip("matchEffect options must be an object literal containing only onFailure and onSuccess.", outer.value.evidence);
    }

    const onFailureNode = objectPropertyInitializer(options, "onFailure", context.sourceText);
    const onSuccessNode = objectPropertyInitializer(options, "onSuccess", context.sourceText);
    if (!onFailureNode || !onSuccessNode || !isArrowFunction(onFailureNode) || !isArrowFunction(onSuccessNode)) {
      return skip("Both matchEffect handlers must be arrow functions.", outer.value.evidence);
    }

    const failure = expressionCall(onFailureNode.body, context.sourceText);
    const success = expressionCall(onSuccessNode.body, context.sourceText);
    if (!failure || !success || failure.arguments.length !== 1 || success.arguments.length !== 1) {
      return skip("Handlers must directly return Effect.fail(...) and Effect.succeed(...).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, failure, "fail")
      || !effectCallMatches(context.semantics, candidate.filePath, success, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, failure)
      || !callResultIsEffect(context.semantics, candidate.filePath, success)) {
      return skip("Handler constructors are not proven Effect.fail / Effect.succeed.", outer.value.evidence);
    }

    const mappedFailure = failure.arguments[0];
    const mappedSuccess = success.arguments[0];
    if (!mappedFailure || !mappedSuccess) return skip("Channel mapper argument is missing.", outer.value.evidence);
    const onFailure = arrowWithBodyText(onFailureNode, mappedFailure, context.sourceText);
    const onSuccess = arrowWithBodyText(onSuccessNode, mappedSuccess, context.sourceText);
    const replacementText = `__codemod_Effect__.mapBoth(${nodeText(self, context.sourceText)}, { onFailure: ${onFailure}, onSuccess: ${onSuccess} })`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "matchEffect only remaps the two channels and is equivalent to Effect.mapBoth.");
  },
  rewrite: rewriteWholeCandidate,
};

export const flipFromMatchEffectRule: EffectConversionRule = {
  id: "effect.flip.from-matchEffect-swap",
  target: "flip",
  description: "Rewrite matchEffect that swaps success and failure unchanged to Effect.flip.",
  selectors: [{
    id: "effect.flip.from-matchEffect-swap.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="matchEffect"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "matchEffect");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.matchEffect must have exactly two arguments.", outer.value.evidence);

    const [self, optionsNode] = outer.value.call.arguments;
    if (!self || !optionsNode) return skip("Effect.matchEffect arguments are incomplete.", outer.value.evidence);
    const options = unwrapParentheses(optionsNode, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["onFailure", "onSuccess"], context.sourceText)) {
      return skip("matchEffect options must contain only onFailure and onSuccess.", outer.value.evidence);
    }
    const onFailureNode = objectPropertyInitializer(options, "onFailure", context.sourceText);
    const onSuccessNode = objectPropertyInitializer(options, "onSuccess", context.sourceText);
    if (!onFailureNode || !onSuccessNode || !isArrowFunction(onFailureNode) || !isArrowFunction(onSuccessNode)) {
      return skip("Both handlers must be arrow functions.", outer.value.evidence);
    }
    const failureParameter = singleArrowParameterIdentifier(onFailureNode);
    const successParameter = singleArrowParameterIdentifier(onSuccessNode);
    if (!failureParameter || !successParameter) return skip("Both handlers must have one simple parameter.", outer.value.evidence);

    const succeed = expressionCall(onFailureNode.body, context.sourceText);
    const fail = expressionCall(onSuccessNode.body, context.sourceText);
    if (!succeed || !fail || succeed.arguments.length !== 1 || fail.arguments.length !== 1) {
      return skip("Handlers must directly return Effect.succeed(error) and Effect.fail(value).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !effectCallMatches(context.semantics, candidate.filePath, fail, "fail")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, fail)) {
      return skip("Handler constructors are not proven Effect.succeed / Effect.fail.", outer.value.evidence);
    }
    if (!succeed.arguments[0] || !fail.arguments[0]
      || !isSameIdentifier(succeed.arguments[0], failureParameter, context.sourceText)
      || !isSameIdentifier(fail.arguments[0], successParameter, context.sourceText)) {
      return skip("Handlers must swap channels without transforming either value.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.flip(${nodeText(self, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Exact channel swap is equivalent to Effect.flip.");
  },
  rewrite: rewriteWholeCandidate,
};

export const mergeFromMatchRule: EffectConversionRule = {
  id: "effect.merge.from-match-identities",
  target: "merge",
  description: "Rewrite Effect.match(self, { onFailure: identity, onSuccess: identity }) to Effect.merge(self).",
  selectors: [{
    id: "effect.merge.from-match-identities.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="match"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "match");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.match must have exactly two arguments.", outer.value.evidence);

    const [self, optionsNode] = outer.value.call.arguments;
    if (!self || !optionsNode) return skip("Effect.match arguments are incomplete.", outer.value.evidence);
    const options = unwrapParentheses(optionsNode, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["onFailure", "onSuccess"], context.sourceText)) {
      return skip("match options must contain only onFailure and onSuccess.", outer.value.evidence);
    }
    const onFailureNode = objectPropertyInitializer(options, "onFailure", context.sourceText);
    const onSuccessNode = objectPropertyInitializer(options, "onSuccess", context.sourceText);
    if (!onFailureNode || !onSuccessNode || !isArrowFunction(onFailureNode) || !isArrowFunction(onSuccessNode)) {
      return skip("Both handlers must be arrow functions.", outer.value.evidence);
    }
    const failureParameter = singleArrowParameterIdentifier(onFailureNode);
    const successParameter = singleArrowParameterIdentifier(onSuccessNode);
    if (!failureParameter || !successParameter
      || !isSameIdentifier(onFailureNode.body, failureParameter, context.sourceText)
      || !isSameIdentifier(onSuccessNode.body, successParameter, context.sourceText)) {
      return skip("Both match handlers must be identity functions.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.merge(${nodeText(self, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity match handlers simply merge the success and failure channels.");
  },
  rewrite: rewriteWholeCandidate,
};

export const RULE_EXPANSION_RULES: readonly EffectConversionRule[] = [
  asFromMapConstantPrimitiveRule,
  asVoidFromMapRule,
  asSomeFromMapOptionSomeRule,
  asSomeErrorFromMapErrorOptionSomeRule,
  mapErrorCauseFromCatchAllCauseFailCauseRule,
  filterOrElseFromFlatMapRule,
  mapBothFromMatchEffectRule,
  flipFromMatchEffectRule,
  mergeFromMatchRule,
];
