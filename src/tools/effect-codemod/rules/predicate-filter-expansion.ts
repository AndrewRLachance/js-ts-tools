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
  isBooleanLiteralExpression,
  isConditionalExpression,
  isIdentifier,
  isNegationOfIdentifier,
  isObjectLiteralExpression,
  isSameIdentifier,
  isStringLiteralExpression,
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

export const filterOrDieFromFlatMapRule: EffectConversionRule = {
  id: "effect.filterOrDie.from-flatMap-conditional",
  target: "filterOrDie",
  description: "Rewrite flatMap identity validation with Effect.die fallback to Effect.filterOrDie.",
  selectors: [{
    id: "effect.filterOrDie.from-flatMap-conditional.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
    }
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Validation callback must have one simple identifier parameter.", outer.value.evidence);

    const conditional = unwrapParentheses(mapper.body, context.sourceText);
    if (!isConditionalExpression(conditional)) {
      return skip("Validation callback body must be a conditional expression.", outer.value.evidence);
    }

    const succeed = expressionCall(conditional.whenTrue, context.sourceText);
    const die = expressionCall(conditional.whenFalse, context.sourceText);
    if (!succeed || !die || succeed.arguments.length !== 1 || die.arguments.length !== 1) {
      return skip("Conditional branches must be Effect.succeed(value) and Effect.die(defect).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !effectCallMatches(context.semantics, candidate.filePath, die, "die")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, die)) {
      return skip("Conditional branches are not proven Effect.succeed / Effect.die calls.", outer.value.evidence);
    }

    const successValue = succeed.arguments[0];
    const defect = die.arguments[0];
    if (!successValue || !defect || !isSameIdentifier(successValue, parameter, context.sourceText)) {
      return skip("Success branch must preserve the callback parameter unchanged.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, conditional.condition, context.sourceText);
    const onDie = arrowWithBodyText(mapper, defect, context.sourceText);
    const replacementText = `__codemod_Effect__.filterOrDie(${nodeText(self, context.sourceText)}, ${predicate}, ${onDie})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity success plus Effect.die fallback is equivalent to Effect.filterOrDie.");
  },
  rewrite: rewriteWholeCandidate,
};

export const filterOrDieMessageFromFlatMapRule: EffectConversionRule = {
  id: "effect.filterOrDieMessage.from-flatMap-dieMessage",
  target: "filterOrDieMessage",
  description: "Rewrite flatMap identity validation with a literal Effect.dieMessage fallback to Effect.filterOrDieMessage.",
  selectors: [{
    id: "effect.filterOrDieMessage.from-flatMap-dieMessage.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
    }
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Validation callback must have one simple identifier parameter.", outer.value.evidence);

    const conditional = unwrapParentheses(mapper.body, context.sourceText);
    if (!isConditionalExpression(conditional)) {
      return skip("Validation callback body must be a conditional expression.", outer.value.evidence);
    }

    const succeed = expressionCall(conditional.whenTrue, context.sourceText);
    const dieMessage = expressionCall(conditional.whenFalse, context.sourceText);
    if (!succeed || !dieMessage || succeed.arguments.length !== 1 || dieMessage.arguments.length !== 1) {
      return skip("Conditional branches must be Effect.succeed(value) and Effect.dieMessage(message).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !effectCallMatches(context.semantics, candidate.filePath, dieMessage, "dieMessage")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, dieMessage)) {
      return skip("Conditional branches are not proven Effect.succeed / Effect.dieMessage calls.", outer.value.evidence);
    }

    const successValue = succeed.arguments[0];
    const message = dieMessage.arguments[0];
    if (!successValue || !message || !isSameIdentifier(successValue, parameter, context.sourceText)) {
      return skip("Success branch must preserve the callback parameter unchanged.", outer.value.evidence);
    }
    if (!isStringLiteralExpression(message, context.sourceText)) {
      return skip("Only string literals are moved to Effect.filterOrDieMessage construction time.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, conditional.condition, context.sourceText);
    const replacementText = `__codemod_Effect__.filterOrDieMessage(${nodeText(self, context.sourceText)}, ${predicate}, ${nodeText(message, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Literal dieMessage validation is timing-insensitive and equivalent to Effect.filterOrDieMessage.");
  },
  rewrite: rewriteWholeCandidate,
};

export const liftPredicateFromFilterOrFailSucceedRule: EffectConversionRule = {
  id: "effect.liftPredicate.from-filterOrFail-succeed",
  target: "liftPredicate",
  description: "Rewrite Effect.filterOrFail(Effect.succeed(value), predicate, onFailure) to Effect.liftPredicate.",
  selectors: [{
    id: "effect.liftPredicate.from-filterOrFail-succeed.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="filterOrFail"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "filterOrFail");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 3) {
      return skip("Only the explicit-error Effect.filterOrFail overload is converted.", outer.value.evidence);
    }

    const [source, predicate, onFailure] = outer.value.call.arguments;
    if (!source || !predicate || !onFailure) return skip("Effect.filterOrFail arguments are incomplete.", outer.value.evidence);
    const succeed = expressionCall(source, context.sourceText);
    if (!succeed || succeed.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)) {
      return skip("Source must be proven Effect.succeed(value).", outer.value.evidence);
    }
    const value = succeed.arguments[0];
    if (!value) return skip("Effect.succeed value is missing.", outer.value.evidence);

    const replacementText = `__codemod_Effect__.liftPredicate(${nodeText(value, context.sourceText)}, ${nodeText(predicate, context.sourceText)}, ${nodeText(onFailure, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "filterOrFail over a pure succeed source is exactly Effect.liftPredicate.");
  },
  rewrite: rewriteWholeCandidate,
};

export const isSuccessFromMatchRule: EffectConversionRule = {
  id: "effect.isSuccess.from-match-booleans",
  target: "isSuccess",
  description: "Rewrite Effect.match with false/true handlers to Effect.isSuccess.",
  selectors: [{
    id: "effect.isSuccess.from-match-booleans.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="match"]',
  }],
  analyze(candidate, context) {
    return analyzeBooleanMatch(this, candidate, context, false, true, "isSuccess");
  },
  rewrite: rewriteWholeCandidate,
};

export const isFailureFromMatchRule: EffectConversionRule = {
  id: "effect.isFailure.from-match-booleans",
  target: "isFailure",
  description: "Rewrite Effect.match with true/false handlers to Effect.isFailure.",
  selectors: [{
    id: "effect.isFailure.from-match-booleans.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="match"]',
  }],
  analyze(candidate, context) {
    return analyzeBooleanMatch(this, candidate, context, true, false, "isFailure");
  },
  rewrite: rewriteWholeCandidate,
};

export const existsFromFindFirstRule: EffectConversionRule = {
  id: "effect.exists.from-findFirst-isSome",
  target: "exists",
  description: "Rewrite Effect.map(Effect.findFirst(...), option => Option.isSome(option)) to Effect.exists.",
  selectors: [{
    id: "effect.exists.from-findFirst-isSome.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [source, mapper] = outer.value.call.arguments;
    if (!source || !mapper || !isArrowFunction(mapper)) return skip("Outer mapper must be an arrow function.", outer.value.evidence);
    const optionParameter = singleArrowParameterIdentifier(mapper);
    if (!optionParameter) return skip("Outer mapper must have one simple Option parameter.", outer.value.evidence);

    const findFirst = expressionCall(source, context.sourceText);
    if (!findFirst || findFirst.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, findFirst, "findFirst")
      || !callResultIsEffect(context.semantics, candidate.filePath, findFirst)) {
      return skip("Source must be proven Effect.findFirst(elements, predicate).", outer.value.evidence);
    }

    const isSome = expressionCall(mapper.body, context.sourceText);
    if (!isSome || isSome.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, isSome, "Option", "isSome")) {
      return skip("Outer mapper must directly call Option.isSome(option).", outer.value.evidence);
    }
    const optionValue = isSome.arguments[0];
    if (!optionValue || !isSameIdentifier(optionValue, optionParameter, context.sourceText)) {
      return skip("Option.isSome must inspect the mapper parameter unchanged.", outer.value.evidence);
    }

    const [elements, predicate] = findFirst.arguments;
    if (!elements || !predicate) return skip("Effect.findFirst arguments are incomplete.", outer.value.evidence);
    const replacementText = `__codemod_Effect__.exists(${nodeText(elements, context.sourceText)}, ${nodeText(predicate, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "findFirst followed by Option.isSome has the same short-circuit semantics as Effect.exists.");
  },
  rewrite: rewriteWholeCandidate,
};

export const everyFromFindFirstNegatedRule: EffectConversionRule = {
  id: "effect.every.from-findFirst-negated-isNone",
  target: "every",
  description: "Rewrite first failing predicate search followed by Option.isNone to Effect.every.",
  selectors: [{
    id: "effect.every.from-findFirst-negated-isNone.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [source, resultMapper] = outer.value.call.arguments;
    if (!source || !resultMapper || !isArrowFunction(resultMapper)) return skip("Outer mapper must be an arrow function.", outer.value.evidence);
    const optionParameter = singleArrowParameterIdentifier(resultMapper);
    if (!optionParameter) return skip("Outer mapper must have one simple Option parameter.", outer.value.evidence);

    const isNone = expressionCall(resultMapper.body, context.sourceText);
    if (!isNone || isNone.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, isNone, "Option", "isNone")) {
      return skip("Outer mapper must directly call Option.isNone(option).", outer.value.evidence);
    }
    const optionValue = isNone.arguments[0];
    if (!optionValue || !isSameIdentifier(optionValue, optionParameter, context.sourceText)) {
      return skip("Option.isNone must inspect the mapper parameter unchanged.", outer.value.evidence);
    }

    const findFirst = expressionCall(source, context.sourceText);
    if (!findFirst || findFirst.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, findFirst, "findFirst")
      || !callResultIsEffect(context.semantics, candidate.filePath, findFirst)) {
      return skip("Source must be proven Effect.findFirst(elements, predicate).", outer.value.evidence);
    }
    const [elements, findPredicate] = findFirst.arguments;
    if (!elements || !findPredicate || !isArrowFunction(findPredicate) || !hasSimpleArrowParameters(findPredicate, 2)) {
      return skip("findFirst predicate must be an arrow with at most value/index parameters.", outer.value.evidence);
    }

    const negatingMap = expressionCall(findPredicate.body, context.sourceText);
    if (!negatingMap || negatingMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, negatingMap, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, negatingMap)) {
      return skip("findFirst predicate must directly map an effectful predicate result.", outer.value.evidence);
    }
    const [predicateEffect, negateMapper] = negatingMap.arguments;
    if (!predicateEffect || !negateMapper || !isArrowFunction(negateMapper)) {
      return skip("Negating Effect.map arguments are incomplete.", outer.value.evidence);
    }
    const boolParameter = singleArrowParameterIdentifier(negateMapper);
    if (!boolParameter || !isNegationOfIdentifier(negateMapper.body, boolParameter, context.sourceText)) {
      return skip("Inner mapper must negate its boolean parameter exactly.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(findPredicate, predicateEffect, context.sourceText);
    const replacementText = `__codemod_Effect__.every(${nodeText(elements, context.sourceText)}, ${predicate})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Searching for the first negated predicate and testing None is equivalent to short-circuiting Effect.every.");
  },
  rewrite: rewriteWholeCandidate,
};

export const filterMapFromAllArrayFilterMapRule: EffectConversionRule = {
  id: "effect.filterMap.from-all-array-filterMap",
  target: "filterMap",
  description: "Rewrite Effect.map(Effect.all(effects), values => Array.filterMap(values, f)) to Effect.filterMap.",
  selectors: [{
    id: "effect.filterMap.from-all-array-filterMap.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [source, mapper] = outer.value.call.arguments;
    if (!source || !mapper || !isArrowFunction(mapper)) return skip("Outer mapper must be an arrow function.", outer.value.evidence);
    const valuesParameter = singleArrowParameterIdentifier(mapper);
    if (!valuesParameter) return skip("Outer mapper must have one simple collection parameter.", outer.value.evidence);

    const all = expressionCall(source, context.sourceText);
    if (!all || all.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, all, "all")
      || !callResultIsEffect(context.semantics, candidate.filePath, all)) {
      return skip("Source must be option-free Effect.all(effects).", outer.value.evidence);
    }

    const arrayFilterMap = expressionCall(mapper.body, context.sourceText);
    if (!arrayFilterMap || arrayFilterMap.arguments.length !== 2
      || !effectModuleCallMatches(context.semantics, candidate.filePath, arrayFilterMap, "Array", "filterMap")) {
      return skip("Outer mapper must directly call Effect Array.filterMap(values, mapper).", outer.value.evidence);
    }
    const [values, filterMapper] = arrayFilterMap.arguments;
    if (!values || !filterMapper || !isSameIdentifier(values, valuesParameter, context.sourceText)) {
      return skip("Array.filterMap must consume the collected values unchanged.", outer.value.evidence);
    }
    const effects = all.arguments[0];
    if (!effects) return skip("Effect.all input is missing.", outer.value.evidence);

    const replacementText = `__codemod_Effect__.filterMap(${nodeText(effects, context.sourceText)}, ${nodeText(filterMapper, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "V3 Effect.filterMap is sequential collection followed by Array.filterMap.");
  },
  rewrite: rewriteWholeCandidate,
};

export const filterFromForEachOptionsRule: EffectConversionRule = {
  id: "effect.filter.from-forEach-options",
  target: "filter",
  description: "Rewrite sequential forEach producing Options plus Array.getSomes to Effect.filter.",
  selectors: [{
    id: "effect.filter.from-forEach-options.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);

    const [source, collector] = outer.value.call.arguments;
    if (!source || !collector || !isArrowFunction(collector)) return skip("Outer collector must be an arrow function.", outer.value.evidence);
    const optionsParameter = singleArrowParameterIdentifier(collector);
    if (!optionsParameter) return skip("Outer collector must have one simple Option-array parameter.", outer.value.evidence);

    const getSomes = expressionCall(collector.body, context.sourceText);
    if (!getSomes || getSomes.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, getSomes, "Array", "getSomes")) {
      return skip("Outer collector must directly call Effect Array.getSomes(options).", outer.value.evidence);
    }
    const collectedOptions = getSomes.arguments[0];
    if (!collectedOptions || !isSameIdentifier(collectedOptions, optionsParameter, context.sourceText)) {
      return skip("Array.getSomes must consume the outer mapper parameter unchanged.", outer.value.evidence);
    }

    const forEach = expressionCall(source, context.sourceText);
    if (!forEach || forEach.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, forEach, "forEach")
      || !callResultIsEffect(context.semantics, candidate.filePath, forEach)) {
      return skip("Source must be option-free Effect.forEach(elements, callback).", outer.value.evidence);
    }
    const [elements, callback] = forEach.arguments;
    if (!elements || !callback || !isArrowFunction(callback) || !hasSimpleArrowParameters(callback, 2)) {
      return skip("forEach callback must be an arrow with at most value/index parameters.", outer.value.evidence);
    }
    const valueParameterNode = callback.parameters[0]?.name;
    if (!valueParameterNode || !isIdentifier(valueParameterNode)) {
      return skip("forEach callback must have a simple value parameter.", outer.value.evidence);
    }

    const predicateMap = expressionCall(callback.body, context.sourceText);
    if (!predicateMap || predicateMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, predicateMap, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, predicateMap)) {
      return skip("forEach callback must directly map an effectful boolean predicate.", outer.value.evidence);
    }
    const [predicateEffect, keepMapper] = predicateMap.arguments;
    if (!predicateEffect || !keepMapper || !isArrowFunction(keepMapper)) {
      return skip("Predicate Effect.map arguments are incomplete.", outer.value.evidence);
    }
    const keepParameter = singleArrowParameterIdentifier(keepMapper);
    if (!keepParameter) return skip("Predicate result mapper must have one simple boolean parameter.", outer.value.evidence);

    const conditional = unwrapParentheses(keepMapper.body, context.sourceText);
    if (!isConditionalExpression(conditional) || !isSameIdentifier(conditional.condition, keepParameter, context.sourceText)) {
      return skip("Predicate result mapper must branch directly on its boolean parameter.", outer.value.evidence);
    }
    const some = expressionCall(conditional.whenTrue, context.sourceText);
    const none = expressionCall(conditional.whenFalse, context.sourceText);
    if (!some || !none || some.arguments.length !== 1 || none.arguments.length !== 0
      || !effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")
      || !effectModuleCallMatches(context.semantics, candidate.filePath, none, "Option", "none")) {
      return skip("Predicate branches must be Option.some(value) and Option.none().", outer.value.evidence);
    }
    const keptValue = some.arguments[0];
    if (!keptValue || !isSameIdentifier(keptValue, valueParameterNode, context.sourceText)) {
      return skip("Option.some must preserve the original collection element unchanged.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(callback, predicateEffect, context.sourceText);
    const replacementText = `__codemod_Effect__.filter(${nodeText(elements, context.sourceText)}, ${predicate})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Sequential forEach boolean validation plus Option compaction is equivalent to Effect.filter.");
  },
  rewrite: rewriteWholeCandidate,
};

export const PREDICATE_FILTER_EXPANSION_RULES: readonly EffectConversionRule[] = [
  filterOrDieFromFlatMapRule,
  filterOrDieMessageFromFlatMapRule,
  liftPredicateFromFilterOrFailSucceedRule,
  isSuccessFromMatchRule,
  isFailureFromMatchRule,
  existsFromFindFirstRule,
  everyFromFindFirstNegatedRule,
  filterMapFromAllArrayFilterMapRule,
  filterFromForEachOptionsRule,
];

function analyzeBooleanMatch(
  rule: EffectConversionRule,
  candidate: Parameters<EffectConversionRule["analyze"]>[0],
  context: Parameters<EffectConversionRule["analyze"]>[1],
  failureValue: boolean,
  successValue: boolean,
  target: "isSuccess" | "isFailure",
) {
  const outer = proveOuterEffectCall(candidate, context, "match");
  if (!outer.ok) return outer.decision;
  if (outer.value.call.arguments.length !== 2) return skip("Effect.match must have exactly two arguments.", outer.value.evidence);

  const [self, optionsNode] = outer.value.call.arguments;
  if (!self || !optionsNode) return skip("Effect.match arguments are incomplete.", outer.value.evidence);
  const options = unwrapParentheses(optionsNode, context.sourceText);
  if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["onFailure", "onSuccess"], context.sourceText)) {
    return skip("Effect.match options must contain only onFailure and onSuccess.", outer.value.evidence);
  }
  const onFailure = objectPropertyInitializer(options, "onFailure", context.sourceText);
  const onSuccess = objectPropertyInitializer(options, "onSuccess", context.sourceText);
  if (!onFailure || !onSuccess || !isArrowFunction(onFailure) || !isArrowFunction(onSuccess)
    || !hasSimpleArrowParameters(onFailure, 1) || !hasSimpleArrowParameters(onSuccess, 1)) {
    return skip("Both Effect.match handlers must be simple arrows.", outer.value.evidence);
  }
  if (!isBooleanLiteralExpression(onFailure.body, failureValue, context.sourceText)
    || !isBooleanLiteralExpression(onSuccess.body, successValue, context.sourceText)) {
    return skip(`Effect.match handlers are not the exact boolean shape for Effect.${target}.`, outer.value.evidence);
  }

  const replacementText = `__codemod_Effect__.${target}(${nodeText(self, context.sourceText)})`;
  return convert(rule.id, rule.target, candidate, outer.value.evidence, replacementText, `Effect.${target} is implemented by the same boolean Effect.match fold in V3.`);
}
